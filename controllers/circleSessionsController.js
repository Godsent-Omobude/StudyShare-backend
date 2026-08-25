import prisma from "../config/prisma.js";
import { getMembership, canManage } from "../services/circleAccess.js";
import { createNotification, emitToCircle } from "../services/circleRealtime.js";

const parseId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isNaN(id) ? null : id;
};

const summarizeRsvps = (rsvps, userId) => {
  const counts = { GOING: 0, MAYBE: 0, DECLINED: 0 };
  let myStatus = null;

  rsvps.forEach((rsvp) => {
    if (counts[rsvp.status] !== undefined) counts[rsvp.status] += 1;
    if (rsvp.userId === userId) myStatus = rsvp.status;
  });

  return { counts, myStatus };
};

const serializeSession = (session, userId) => {
  const { rsvps, ...fields } = session;
  const { counts, myStatus } = summarizeRsvps(rsvps || [], userId);

  return {
    ...fields,
    rsvpCounts: counts,
    myRsvpStatus: myStatus
  };
};

// List upcoming (and, on request, past) study sessions for a circle.
export const listSessions = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const includePast = String(req.query.includePast || "").toLowerCase() === "true";

    const sessions = await prisma.studySession.findMany({
      where: {
        circleId,
        ...(includePast ? {} : { scheduledFor: { gte: new Date() } })
      },
      include: {
        rsvps: { select: { userId: true, status: true } },
        createdByUser: { select: { username: true } }
      },
      orderBy: { scheduledFor: "asc" }
    });

    return res.json(sessions.map((session) => serializeSession(session, req.user.id)));
  } catch (error) {
    console.error("List study sessions error:", error);
    return res.status(500).json({ message: error.message || "Unable to load study sessions." });
  }
};

// Schedule a new session. Any member can propose one — a circle is
// collaborative, not just owner/moderator-run.
export const createSession = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const { title, description, location, scheduledFor, durationMinutes } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Please give the session a title." });
    }

    const parsedDate = new Date(scheduledFor);
    if (!scheduledFor || Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: "Please provide a valid date and time." });
    }

    const parsedDuration = durationMinutes === undefined ? 60 : Number(durationMinutes);
    if (!Number.isInteger(parsedDuration) || parsedDuration < 5 || parsedDuration > 720) {
      return res.status(400).json({ message: "Duration must be between 5 and 720 minutes." });
    }

    const session = await prisma.studySession.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        location: location?.trim() || null,
        scheduledFor: parsedDate,
        durationMinutes: parsedDuration,
        circleId,
        createdByUserId: req.user.id,
        rsvps: { create: [{ userId: req.user.id, status: "GOING" }] }
      },
      include: {
        rsvps: { select: { userId: true, status: true } },
        createdByUser: { select: { username: true } }
      }
    });

    emitToCircle(circleId, "session:new", serializeSession(session, req.user.id));

    const members = await prisma.circleMember.findMany({
      where: { circleId, userId: { not: req.user.id } },
      select: { userId: true }
    });

    await Promise.all(
      members.map(({ userId }) =>
        createNotification({
          userId,
          type: "CIRCLE_SESSION_SCHEDULED",
          title: "New study session scheduled",
          body: `${req.user.username} scheduled "${session.title}" for ${parsedDate.toLocaleString()}.`,
          circleId,
          actorUserId: req.user.id
        })
      )
    );

    return res.status(201).json(serializeSession(session, req.user.id));
  } catch (error) {
    console.error("Create study session error:", error);
    return res.status(500).json({ message: error.message || "Unable to schedule this session." });
  }
};

// Edit a session. Only the creator or a manager (owner/moderator) can.
export const updateSession = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const sessionId = parseId(req.params.sessionId);
    if (!circleId || !sessionId) return res.status(400).json({ message: "Invalid ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const existing = await prisma.studySession.findFirst({ where: { id: sessionId, circleId } });
    if (!existing) return res.status(404).json({ message: "Study session not found." });

    if (existing.createdByUserId !== req.user.id && !canManage(membership)) {
      return res.status(403).json({ message: "You can't edit this session." });
    }

    const { title, description, location, scheduledFor, durationMinutes } = req.body;
    const data = {};

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ message: "Title cannot be empty." });
      data.title = title.trim();
    }
    if (description !== undefined) data.description = description?.trim() || null;
    if (location !== undefined) data.location = location?.trim() || null;
    if (scheduledFor !== undefined) {
      const parsedDate = new Date(scheduledFor);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ message: "Please provide a valid date and time." });
      }
      data.scheduledFor = parsedDate;
    }
    if (durationMinutes !== undefined) {
      const parsedDuration = Number(durationMinutes);
      if (!Number.isInteger(parsedDuration) || parsedDuration < 5 || parsedDuration > 720) {
        return res.status(400).json({ message: "Duration must be between 5 and 720 minutes." });
      }
      data.durationMinutes = parsedDuration;
    }

    const session = await prisma.studySession.update({
      where: { id: sessionId },
      data,
      include: {
        rsvps: { select: { userId: true, status: true } },
        createdByUser: { select: { username: true } }
      }
    });

    emitToCircle(circleId, "session:updated", serializeSession(session, req.user.id));

    return res.json(serializeSession(session, req.user.id));
  } catch (error) {
    console.error("Update study session error:", error);
    return res.status(500).json({ message: error.message || "Unable to update this session." });
  }
};

// Cancel/delete a session. Same permission rule as editing.
export const deleteSession = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const sessionId = parseId(req.params.sessionId);
    if (!circleId || !sessionId) return res.status(400).json({ message: "Invalid ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const existing = await prisma.studySession.findFirst({ where: { id: sessionId, circleId } });
    if (!existing) return res.status(404).json({ message: "Study session not found." });

    if (existing.createdByUserId !== req.user.id && !canManage(membership)) {
      return res.status(403).json({ message: "You can't cancel this session." });
    }

    await prisma.studySession.delete({ where: { id: sessionId } });

    emitToCircle(circleId, "session:deleted", { id: sessionId });

    return res.json({ message: "Study session cancelled." });
  } catch (error) {
    console.error("Delete study session error:", error);
    return res.status(500).json({ message: error.message || "Unable to cancel this session." });
  }
};

// RSVP to a session as GOING / MAYBE / DECLINED.
export const rsvpSession = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const sessionId = parseId(req.params.sessionId);
    if (!circleId || !sessionId) return res.status(400).json({ message: "Invalid ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const existing = await prisma.studySession.findFirst({ where: { id: sessionId, circleId } });
    if (!existing) return res.status(404).json({ message: "Study session not found." });

    const { status } = req.body;
    if (!["GOING", "MAYBE", "DECLINED"].includes(status)) {
      return res.status(400).json({ message: "Status must be GOING, MAYBE, or DECLINED." });
    }

    await prisma.studySessionRSVP.upsert({
      where: { sessionId_userId: { sessionId, userId: req.user.id } },
      update: { status },
      create: { sessionId, userId: req.user.id, status }
    });

    const session = await prisma.studySession.findUnique({
      where: { id: sessionId },
      include: {
        rsvps: { select: { userId: true, status: true } },
        createdByUser: { select: { username: true } }
      }
    });

    emitToCircle(circleId, "session:updated", serializeSession(session, req.user.id));

    return res.json(serializeSession(session, req.user.id));
  } catch (error) {
    console.error("RSVP study session error:", error);
    return res.status(500).json({ message: error.message || "Unable to save your RSVP." });
  }
};
