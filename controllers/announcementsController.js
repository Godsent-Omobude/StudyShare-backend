import prisma from "../config/prisma.js";
import { sendAnnouncementPush } from "../services/pushNotificationService.js";
import { validateExternalUrl } from "../utils/urlValidation.js";

// Admin announcements: one message sent to every user.
//
// Admin side (mounted under /api/admin, so already behind protect + admin):
//   POST   /announcements        create + deliver
//   GET    /announcements        history with dismissal counts
//   PATCH  /announcements/:id    retire / re-activate / change expiry
//   DELETE /announcements/:id    remove entirely (also removes bell entries)
// User side (mounted at /api/announcements, behind protect):
//   GET    /active               popups this user hasn't dismissed yet
//   POST   /:id/dismiss          never show this one to this user again

const TITLE_MAX = 100;
const BODY_MAX = 500;
const LABEL_MAX = 30;
const ACTIVE_POPUP_LIMIT = 5;
const BELL_CHUNK_SIZE = 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;

const clean = (value) => (typeof value === "string" ? value.trim() : "");

const parseId = (raw) => {
  const id = Number.parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
};

// A link is either an in-app path ("/materials") or a real https URL.
// "//evil.com" and "/\evil.com" are rejected: browsers treat both as
// protocol-relative absolute URLs, not in-app paths.
const normalizeLink = (rawLink) => {
  const value = clean(rawLink);
  if (!value) return null;
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\") || value.length > 200) {
      throw new Error("That in-app link is not valid.");
    }
    return value;
  }
  return validateExternalUrl(value).normalizedUrl;
};

const parseExpiry = (raw) => {
  if (raw === undefined || raw === null || raw === "") return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("The expiry date is not valid.");
  if (date.getTime() <= Date.now()) throw new Error("The expiry date must be in the future.");
  return date;
};

// Runs after the admin's request has already been answered: adds the bell
// entry for every user, then (optionally) sends the push. Failures are
// logged, never thrown, because there is no request left to fail.
const deliverAnnouncement = async (announcement) => {
  try {
    const recipients = await prisma.user.findMany({
      where: { terminatedAt: null },
      select: { id: true },
    });

    for (let start = 0; start < recipients.length; start += BELL_CHUNK_SIZE) {
      const chunk = recipients.slice(start, start + BELL_CHUNK_SIZE);
      await prisma.notification.createMany({
        data: chunk.map(({ id }) => ({
          userId: id,
          type: "ANNOUNCEMENT",
          title: announcement.title,
          body: announcement.body,
          announcementId: announcement.id,
        })),
      });
    }
  } catch (error) {
    console.error("[announcements] Failed to add bell entries:", error.message);
  }

  if (!announcement.sendPush) return;

  try {
    const { delivered, failed } = await sendAnnouncementPush(announcement);
    await prisma.announcement.update({
      where: { id: announcement.id },
      data: { pushedAt: new Date(), pushDelivered: delivered, pushFailed: failed },
    });
  } catch (error) {
    console.error("[announcements] Failed to record push result:", error.message);
  }
};

// ---------------------------------------------------------------- admin ---

export const createAnnouncement = async (req, res) => {
  try {
    const title = clean(req.body?.title);
    const body = clean(req.body?.body);
    const sendPush = req.body?.sendPush === true;

    if (!title) return res.status(400).json({ message: "Please enter a title." });
    if (!body) return res.status(400).json({ message: "Please enter a message." });
    if (title.length > TITLE_MAX) {
      return res.status(400).json({ message: `The title must be ${TITLE_MAX} characters or fewer.` });
    }
    if (body.length > BODY_MAX) {
      return res.status(400).json({ message: `The message must be ${BODY_MAX} characters or fewer.` });
    }

    let linkUrl;
    let expiresAt;
    try {
      linkUrl = normalizeLink(req.body?.linkUrl);
      expiresAt = parseExpiry(req.body?.expiresAt);
    } catch (validationError) {
      return res.status(400).json({ message: validationError.message });
    }

    let linkLabel = null;
    if (linkUrl) {
      linkLabel = clean(req.body?.linkLabel) || "Learn more";
      if (linkLabel.length > LABEL_MAX) {
        return res.status(400).json({ message: `The button text must be ${LABEL_MAX} characters or fewer.` });
      }
    }

    // A double-tap on "Send" must not announce the same thing twice to
    // every user.
    const duplicate = await prisma.announcement.findFirst({
      where: {
        createdById: req.user.id,
        title,
        body,
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (duplicate) {
      return res.status(409).json({ message: "This announcement was just sent. Please wait a minute before sending it again." });
    }

    const announcement = await prisma.announcement.create({
      data: { title, body, linkUrl, linkLabel, expiresAt, sendPush, createdById: req.user.id },
    });

    // Respond first; delivering to every user can take a while.
    deliverAnnouncement(announcement);

    return res.status(201).json({ announcement });
  } catch (error) {
    console.error("[announcements] create failed:", error);
    return res.status(500).json({ message: "Could not send the announcement." });
  }
};

export const listAnnouncements = async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        createdBy: { select: { id: true, fullName: true, username: true } },
        _count: { select: { dismissals: true } },
      },
    });
    return res.json({ announcements });
  } catch (error) {
    console.error("[announcements] list failed:", error);
    return res.status(500).json({ message: "Could not load announcements." });
  }
};

export const updateAnnouncement = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid announcement ID." });

    const data = {};
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== "boolean") {
        return res.status(400).json({ message: "'active' must be true or false." });
      }
      data.active = req.body.active;
    }
    if (req.body?.expiresAt !== undefined) {
      try {
        data.expiresAt = parseExpiry(req.body.expiresAt);
      } catch (validationError) {
        return res.status(400).json({ message: validationError.message });
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: "Nothing to update." });
    }

    const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Announcement not found." });

    const announcement = await prisma.announcement.update({ where: { id }, data });
    return res.json({ announcement });
  } catch (error) {
    console.error("[announcements] update failed:", error);
    return res.status(500).json({ message: "Could not update the announcement." });
  }
};

export const deleteAnnouncement = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid announcement ID." });

    const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Announcement not found." });

    // Dismissals and every user's bell entry are removed by ON DELETE CASCADE.
    await prisma.announcement.delete({ where: { id } });
    return res.json({ message: "Announcement deleted." });
  } catch (error) {
    console.error("[announcements] delete failed:", error);
    return res.status(500).json({ message: "Could not delete the announcement." });
  }
};

// ----------------------------------------------------------------- user ---

export const getActiveAnnouncements = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { createdAt: true },
    });
    if (!user) return res.status(401).json({ message: "Session expired. Please log in again." });

    const announcements = await prisma.announcement.findMany({
      where: {
        active: true,
        // Someone who joined after an announcement went out shouldn't be
        // greeted by old news.
        createdAt: { gte: user.createdAt },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        dismissals: { none: { userId: req.user.id } },
      },
      orderBy: { createdAt: "desc" },
      take: ACTIVE_POPUP_LIMIT,
      select: { id: true, title: true, body: true, linkUrl: true, linkLabel: true, createdAt: true },
    });

    return res.json({ announcements });
  } catch (error) {
    console.error("[announcements] active failed:", error);
    return res.status(500).json({ message: "Could not load announcements." });
  }
};

export const dismissAnnouncement = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid announcement ID." });

    const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Announcement not found." });

    await prisma.announcementDismissal.upsert({
      where: { announcementId_userId: { announcementId: id, userId: req.user.id } },
      update: {},
      create: { announcementId: id, userId: req.user.id },
    });

    // Closing the popup also counts as having read its bell entry.
    await prisma.notification.updateMany({
      where: { userId: req.user.id, announcementId: id, read: false },
      data: { read: true },
    });

    return res.json({ message: "Announcement dismissed." });
  } catch (error) {
    console.error("[announcements] dismiss failed:", error);
    return res.status(500).json({ message: "Could not dismiss the announcement." });
  }
};
