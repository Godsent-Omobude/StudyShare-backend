import prisma from "../config/prisma.js";
import { canManage, getMembership } from "./circleAccess.js";
import { emitToCircle, notifyNewCircleMessage } from "./circleRealtime.js";

const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const parseId = (value) => { const id = Number.parseInt(value, 10); return Number.isNaN(id) ? null : id; };

const formatMessage = (message) => ({
  id: message.id, content: message.deletedAt ? null : message.content, createdAt: message.createdAt,
  editedAt: message.editedAt, deletedAt: message.deletedAt, userId: message.userId,
  username: message.user?.username || "", isPinned: !!message.pinnedMessage,
});

export const createCircleMessage = async (circleId, userId, content) => {
  const membership = await getMembership(circleId, userId);
  if (!membership) fail(403, "You must be a member to chat here.");
  const clean = String(content || "").trim();
  if (!clean) fail(400, "Message cannot be empty.");
  if (clean.length > 2000) fail(400, "Message is too long (max 2000 characters).");
  const message = await prisma.circleMessage.create({
    data: { circleId, userId, content: clean },
    include: { user: { select: { id: true, username: true } } },
  });
  const payload = formatMessage(message);
  emitToCircle(circleId, "message:new", payload);
  await notifyNewCircleMessage({ circleId, actorUserId: userId, messageId: message.id, messagePreview: clean });
  return payload;
};

export const editCircleMessage = async (circleId, messageId, userId, content) => {
  const id = parseId(messageId);
  if (!id) fail(400, "Invalid message ID.");
  const membership = await getMembership(circleId, userId);
  if (!membership) fail(403, "You must be a member of this circle.");
  const message = await prisma.circleMessage.findUnique({ where: { id }, include: { user: { select: { id: true, username: true } }, pinnedMessage: true } });
  if (!message || message.circleId !== circleId) fail(404, "Message not found.");
  if (message.userId !== userId) fail(403, "You can only edit your own messages.");
  if (message.deletedAt) fail(400, "Deleted messages cannot be edited.");
  if (Date.now() - message.createdAt.getTime() > 5 * 60 * 1000) fail(400, "Messages can only be edited within 5 minutes.");
  const clean = String(content || "").trim();
  if (!clean) fail(400, "Message cannot be empty.");
  if (clean.length > 2000) fail(400, "Message is too long (max 2000 characters).");
  const updated = await prisma.circleMessage.update({
    where: { id }, data: { content: clean, editedAt: new Date() },
    include: { user: { select: { id: true, username: true } }, pinnedMessage: true },
  });
  const payload = formatMessage(updated);
  emitToCircle(circleId, "message:edited", payload);
  return payload;
};

export const deleteCircleMessage = async (circleId, messageId, userId) => {
  const id = parseId(messageId);
  if (!id) fail(400, "Invalid message ID.");
  const membership = await getMembership(circleId, userId);
  if (!membership) fail(403, "You must be a member of this circle.");
  const message = await prisma.circleMessage.findUnique({ where: { id }, include: { user: { select: { id: true, username: true } } } });
  if (!message || message.circleId !== circleId) fail(404, "Message not found.");
  if (message.deletedAt) return formatMessage(message);
  const isOwner = message.userId === userId;
  const withinOwnWindow = Date.now() - message.createdAt.getTime() <= 12 * 60 * 60 * 1000;
  if (!isOwner) {
    if (!canManage(membership)) fail(403, "Only the owner or moderators can delete another member's message.");
    const targetMembership = await getMembership(circleId, message.userId);
    if (membership.role === "MODERATOR" && targetMembership?.role === "OWNER") fail(403, "Moderators cannot delete the owner's message.");
  } else if (!withinOwnWindow) {
    fail(400, "Your messages can only be deleted within 12 hours.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.circleMessage.update({ where: { id }, data: { deletedAt: new Date(), deletedByUserId: userId }, include: { user: { select: { id: true, username: true } } } });
    await tx.circlePinnedMessage.deleteMany({ where: { messageId: id } });
    return result;
  });
  const payload = formatMessage(updated);
  emitToCircle(circleId, "message:deleted", payload);
  return payload;
};

export const pinCircleMessage = async (circleId, messageId, userId) => {
  const id = parseId(messageId);
  if (!id) fail(400, "Invalid message ID.");
  const membership = await getMembership(circleId, userId);
  if (!canManage(membership)) fail(403, "Only the owner or moderators can pin messages.");
  const message = await prisma.circleMessage.findUnique({ where: { id }, include: { user: { select: { id: true, username: true } } } });
  if (!message || message.circleId !== circleId) fail(404, "Message not found.");
  if (message.deletedAt) fail(400, "Deleted messages cannot be pinned.");
  const pin = await prisma.circlePinnedMessage.upsert({
    where: { messageId: id },
    update: { pinnedByUserId: userId },
    create: { circleId, messageId: id, pinnedByUserId: userId },
  });
  const payload = { messageId: id, circleId, pinnedAt: pin.createdAt, pinnedByUserId: userId };
  emitToCircle(circleId, "message:pinned", payload);
  return payload;
};

export const unpinCircleMessage = async (circleId, messageId, userId) => {
  const id = parseId(messageId);
  if (!id) fail(400, "Invalid message ID.");
  const membership = await getMembership(circleId, userId);
  if (!canManage(membership)) fail(403, "Only the owner or moderators can unpin messages.");
  const deleted = await prisma.circlePinnedMessage.deleteMany({ where: { circleId, messageId: id } });
  if (!deleted.count) fail(404, "Pinned message not found.");
  const payload = { messageId: id, circleId };
  emitToCircle(circleId, "message:unpinned", payload);
  return payload;
};
