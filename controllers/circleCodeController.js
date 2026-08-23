import crypto from "crypto";
import prisma from "../config/prisma.js";
import { getMembership } from "../services/circleAccess.js";
import { notifyJoinCodeUsageUpdated } from "../services/circleRealtime.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;
const parseId = (value) => { const id = Number.parseInt(value, 10); return Number.isNaN(id) ? null : id; };
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const randomCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]).join("");

const generateUniqueJoinCode = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomCode();
    const existing = await prisma.studyCircle.findUnique({ where: { joinCode: code }, select: { id: true } });
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique join code. Please try again.");
};

const ownerCircle = async (circleId, userId) => {
  const circle = await prisma.studyCircle.findUnique({ where: { id: circleId } });
  if (!circle) { const e = new Error("Study Circle not found."); e.status = 404; throw e; }
  if (circle.ownerId !== userId) { const e = new Error("Only the Circle Owner can manage the join code."); e.status = 403; throw e; }
  return circle;
};

const send = (res, error, fallback) => res.status(error.status || 500).json({ message: error.message || fallback });

export const getJoinCodeSettings = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const circle = await ownerCircle(circleId, req.user.id);
    return res.json({
      joinCode: circle.joinCode,
      enabled: circle.joinCodeEnabled,
      expiresAt: circle.joinCodeExpiresAt,
      maxUses: circle.joinCodeMaxUses,
      uses: circle.joinCodeUses,
      usesRemaining: circle.joinCodeMaxUses == null ? null : Math.max(0, circle.joinCodeMaxUses - circle.joinCodeUses),
      regeneratedAt: circle.joinCodeRegeneratedAt,
    });
  } catch (error) { return send(res, error, "Unable to load join-code settings."); }
};

export const updateJoinCodeSettings = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const circle = await ownerCircle(circleId, req.user.id);
    const { expiresAt, maxUses, enabled } = req.body;
    let expiry = circle.joinCodeExpiresAt;
    if (expiresAt === null || expiresAt === "") expiry = null;
    else if (expiresAt !== undefined) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) return res.status(400).json({ message: "Expiration must be a valid future date." });
      expiry = parsed;
    }
    let parsedMax = circle.joinCodeMaxUses;
    if (maxUses === null || maxUses === "" || maxUses === undefined) parsedMax = maxUses === undefined ? parsedMax : null;
    else {
      parsedMax = Number(maxUses);
      if (!Number.isInteger(parsedMax) || parsedMax < 1) return res.status(400).json({ message: "Maximum uses must be a positive whole number or unlimited." });
      if (parsedMax < circle.joinCodeUses) return res.status(400).json({ message: "Maximum uses cannot be below the number of successful uses already recorded." });
    }
    const nextEnabled = enabled === undefined ? circle.joinCodeEnabled : Boolean(enabled);
    const updated = await prisma.studyCircle.update({
      where: { id: circleId },
      data: { joinCodeExpiresAt: expiry, joinCodeMaxUses: parsedMax, joinCodeEnabled: nextEnabled },
    });
    return res.json({
      joinCode: updated.joinCode, enabled: updated.joinCodeEnabled, expiresAt: updated.joinCodeExpiresAt,
      maxUses: updated.joinCodeMaxUses, uses: updated.joinCodeUses,
      usesRemaining: updated.joinCodeMaxUses == null ? null : Math.max(0, updated.joinCodeMaxUses - updated.joinCodeUses),
      regeneratedAt: updated.joinCodeRegeneratedAt,
    });
  } catch (error) { return send(res, error, "Unable to update join-code settings."); }
};

export const regenerateJoinCode = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const circle = await ownerCircle(circleId, req.user.id);
    const joinCode = await generateUniqueJoinCode();
    const updated = await prisma.studyCircle.update({
      where: { id: circleId },
      data: { joinCode, joinCodeEnabled: true, joinCodeUses: 0, joinCodeVersion: { increment: 1 }, joinCodeRegeneratedAt: new Date() },
    });
    return res.json({ joinCode: updated.joinCode, enabled: updated.joinCodeEnabled, expiresAt: updated.joinCodeExpiresAt, maxUses: updated.joinCodeMaxUses, uses: updated.joinCodeUses, usesRemaining: updated.joinCodeMaxUses == null ? null : updated.joinCodeMaxUses, regeneratedAt: updated.joinCodeRegeneratedAt, previousCodeInvalidated: circle.joinCode });
  } catch (error) { return send(res, error, "Unable to regenerate the join code."); }
};

export const disableJoinCode = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    await ownerCircle(circleId, req.user.id);
    const updated = await prisma.studyCircle.update({ where: { id: circleId }, data: { joinCodeEnabled: false, joinCodeVersion: { increment: 1 } } });
    return res.json({ enabled: updated.joinCodeEnabled });
  } catch (error) { return send(res, error, "Unable to disable the join code."); }
};

export const enableJoinCode = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const circle = await ownerCircle(circleId, req.user.id);
    if (circle.joinCodeExpiresAt && circle.joinCodeExpiresAt <= new Date()) {
      const joinCode = await generateUniqueJoinCode();
      const updated = await prisma.studyCircle.update({ where: { id: circleId }, data: { joinCode, joinCodeEnabled: true, joinCodeExpiresAt: null, joinCodeUses: 0, joinCodeVersion: { increment: 1 }, joinCodeRegeneratedAt: new Date() } });
      return res.json({ enabled: true, joinCode: updated.joinCode, expiresAt: null, maxUses: updated.joinCodeMaxUses, uses: 0, usesRemaining: updated.joinCodeMaxUses == null ? null : updated.joinCodeMaxUses });
    }
    const updated = await prisma.studyCircle.update({ where: { id: circleId }, data: { joinCodeEnabled: true } });
    return res.json({ enabled: true, joinCode: updated.joinCode, expiresAt: updated.joinCodeExpiresAt, maxUses: updated.joinCodeMaxUses, uses: updated.joinCodeUses, usesRemaining: updated.joinCodeMaxUses == null ? null : Math.max(0, updated.joinCodeMaxUses - updated.joinCodeUses) });
  } catch (error) { return send(res, error, "Unable to enable the join code."); }
};

export const createInvitationLink = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const circle = await ownerCircle(circleId, req.user.id);
    if (!circle.joinCodeEnabled) return res.status(400).json({ message: "Enable the join code before creating an invitation link." });
    if (circle.joinCodeExpiresAt && circle.joinCodeExpiresAt <= new Date()) return res.status(400).json({ message: "The current join code has expired. Regenerate it first." });
    if (circle.joinCodeMaxUses != null && circle.joinCodeUses >= circle.joinCodeMaxUses) return res.status(400).json({ message: "The current join code has no uses remaining." });
    const minutes = Number(req.body.expiresInMinutes || 60);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080) return res.status(400).json({ message: "Invitation link expiration must be between 5 minutes and 7 days." });
    const requestedMax = req.body.maxUses == null || req.body.maxUses === "" ? null : Number(req.body.maxUses);
    if (requestedMax != null && (!Number.isInteger(requestedMax) || requestedMax < 1)) return res.status(400).json({ message: "Invitation maximum uses must be a positive whole number or unlimited." });
    const remaining = circle.joinCodeMaxUses == null ? null : circle.joinCodeMaxUses - circle.joinCodeUses;
    const maxUses = requestedMax == null ? remaining : Math.min(requestedMax, remaining == null ? requestedMax : remaining);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    await prisma.circleInvitationLink.create({ data: { tokenHash: hashToken(token), circleId, expiresAt, maxUses, joinCodeVersion: circle.joinCodeVersion } });
    const base = String(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    return res.status(201).json({ inviteUrl: `${base}/circles/join/${token}`, expiresAt, maxUses });
  } catch (error) { return send(res, error, "Unable to create invitation link."); }
};

// Shared validation for an invitation token: looks the token up, checks
// it against the circle's live join-code state, and reports back why it
// isn't usable (if it isn't) without mutating anything. Used by both the
// read-only preview and the actual join so the two can never disagree.
const validateInvitationToken = async (token) => {
  if (!token || token.length < 40) { const e = new Error("Invalid invitation link."); e.status = 400; throw e; }
  const link = await prisma.circleInvitationLink.findUnique({ where: { tokenHash: hashToken(token) }, include: { circle: true } });
  if (!link) { const e = new Error("This invitation link is invalid or has expired."); e.status = 404; throw e; }
  const circle = link.circle;
  if (!circle) { const e = new Error("This Study Circle no longer exists."); e.status = 404; throw e; }
  const now = new Date();
  if (!circle.joinCodeEnabled || link.joinCodeVersion !== circle.joinCodeVersion || link.expiresAt <= now) { const e = new Error("This invitation link is no longer valid."); e.status = 400; throw e; }
  if (circle.joinCodeExpiresAt && circle.joinCodeExpiresAt <= now) { const e = new Error("The circle's join code has expired."); e.status = 400; throw e; }
  if (circle.joinCodeMaxUses != null && circle.joinCodeUses >= circle.joinCodeMaxUses) { const e = new Error("The circle's join code has reached its maximum uses."); e.status = 400; throw e; }
  if (link.maxUses != null && link.uses >= link.maxUses) { const e = new Error("This invitation link has reached its maximum uses."); e.status = 400; throw e; }
  return { link, circle };
};

// Read-only: lets a logged-in user see what they're about to join before
// committing to it, without consuming a use. Never trusts anything the
// frontend supplies beyond the token itself.
export const previewInvitationToken = async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const { circle } = await validateInvitationToken(token);
    const [memberCount, existingMembership] = await Promise.all([
      prisma.circleMember.count({ where: { circleId: circle.id } }),
      getMembership(circle.id, req.user.id),
    ]);
    return res.json({
      circle: { id: circle.id, name: circle.name, courseCode: circle.courseCode, description: circle.description, visibility: circle.visibility, memberCount },
      alreadyMember: !!existingMembership,
    });
  } catch (error) { return send(res, error, "Unable to validate this invitation link."); }
};

export const joinByInvitationToken = async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const { link, circle } = await validateInvitationToken(token);
    const existing = await getMembership(circle.id, req.user.id);
    if (existing) return res.status(400).json({ message: "You're already a member of this circle.", circleId: circle.id });

    const { membership, updatedCircle } = await prisma.$transaction(async (tx) => {
      if (circle.joinCodeMaxUses != null) {
        const codeUse = await tx.studyCircle.updateMany({ where: { id: circle.id, joinCodeEnabled: true, joinCodeVersion: circle.joinCodeVersion, joinCodeUses: { lt: circle.joinCodeMaxUses } }, data: { joinCodeUses: { increment: 1 } } });
        if (codeUse.count !== 1) { const e = new Error("The circle's join code has reached its maximum uses."); e.status = 400; throw e; }
      } else {
        const used = await tx.studyCircle.updateMany({ where: { id: circle.id, joinCodeEnabled: true, joinCodeVersion: circle.joinCodeVersion }, data: { joinCodeUses: { increment: 1 } } });
        if (used.count !== 1) { const e = new Error("This join code is no longer valid."); e.status = 400; throw e; }
      }
      if (link.maxUses != null) {
        const linkUse = await tx.circleInvitationLink.updateMany({ where: { id: link.id, joinCodeVersion: circle.joinCodeVersion, uses: { lt: link.maxUses } }, data: { uses: { increment: 1 } } });
        if (linkUse.count !== 1) { const e = new Error("This invitation link has reached its maximum uses."); e.status = 400; throw e; }
      } else {
        const linkUse = await tx.circleInvitationLink.updateMany({ where: { id: link.id, joinCodeVersion: circle.joinCodeVersion }, data: { uses: { increment: 1 } } });
        if (linkUse.count !== 1) { const e = new Error("This invitation link is no longer valid."); e.status = 400; throw e; }
      }
      const created = await tx.circleMember.create({ data: { circleId: circle.id, userId: req.user.id, role: "MEMBER" } });
      // Read back the authoritative post-increment value in the same
      // transaction, exactly as the direct join-code path does, so the
      // invitation-link path can never report a stale count either.
      const refreshedCircle = await tx.studyCircle.findUnique({ where: { id: circle.id }, select: { joinCodeUses: true, joinCodeMaxUses: true, ownerId: true } });
      return { membership: created, updatedCircle: refreshedCircle };
    });

    notifyJoinCodeUsageUpdated({ circleId: circle.id, ownerId: updatedCircle.ownerId, uses: updatedCircle.joinCodeUses, maxUses: updatedCircle.joinCodeMaxUses });

    return res.status(201).json({ message: `You joined ${circle.name}.`, circleId: membership.circleId });
  } catch (error) { return send(res, error, "Unable to join using this invitation link."); }
};
