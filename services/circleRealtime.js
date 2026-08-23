import prisma from "../config/prisma.js";

let ioInstance = null;

export const setIO = (io) => { ioInstance = io; };
export const getIO = () => ioInstance;
export const circleRoom = (circleId) => `circle:${circleId}`;
export const userRoom = (userId) => `user:${userId}`;

export const emitToCircle = (circleId, event, payload) => {
  if (ioInstance) ioInstance.to(circleRoom(circleId)).emit(event, payload);
};

export const emitToUser = (userId, event, payload) => {
  if (ioInstance) ioInstance.to(userRoom(userId)).emit(event, payload);
};

export const isUserActiveInCircle = (userId, circleId) => {
  if (!ioInstance) return false;
  const room = ioInstance.sockets.adapter.rooms.get(circleRoom(circleId));
  if (!room) return false;
  return Array.from(room).some((socketId) => ioInstance.sockets.sockets.get(socketId)?.user?.id === userId);
};

export const removeUserFromCircleSockets = (userId, circleId) => {
  if (!ioInstance) return;
  const room = circleRoom(circleId);
  for (const socket of ioInstance.sockets.sockets.values()) {
    if (socket.user?.id === userId && socket.rooms.has(room)) { socket.emit("circle:access-revoked", { circleId }); socket.leave(room); }
  }
};

export const createNotification = async ({ userId, type, title, body, circleId = null, actorUserId = null, messageId = null }) => {
  const notification = await prisma.notification.create({
    data: { userId, type, title, body, circleId, actorUserId, messageId },
    include: { circle: { select: { id: true, name: true } } },
  });
  emitToUser(userId, "notification:new", notification);
  return notification;
};


export const notifyNewCircleMessage = async ({ circleId, actorUserId, messageId, messagePreview }) => {
  const members = await prisma.circleMember.findMany({ where: { circleId }, select: { userId: true } });
  const recipients = members.filter(({ userId }) => userId !== actorUserId && !isUserActiveInCircle(userId, circleId));
  await Promise.all(recipients.map(async ({ userId }) => {
    const groupKey = `CIRCLE_NEW_MESSAGES:${userId}:${circleId}`;
    const notification = await prisma.notification.upsert({
      where: { groupKey },
      update: { body: messagePreview ? messagePreview.slice(0, 120) : "You have new messages in this Study Circle.", messageId, createdAt: new Date(), read: false },
      create: { userId, type: "CIRCLE_NEW_MESSAGES", title: "New Study Circle messages", body: messagePreview ? messagePreview.slice(0, 120) : "You have a new message in this Study Circle.", circleId, actorUserId, messageId, groupKey },
      include: { circle: { select: { id: true, name: true } } },
    });
    emitToUser(userId, "notification:new", notification);
  }));
};

export const notifyCircleManagers = async ({ circleId, ...payload }) => {
  const managers = await prisma.circleMember.findMany({
    where: { circleId, role: { in: ["OWNER", "MODERATOR"] } },
    select: { userId: true },
  });
  await Promise.all(managers.map(({ userId }) => createNotification({ userId, circleId, ...payload })));
};

// Pushes a live join-code usage refresh to the Circle Owner. The owner's
// Join Code Management panel listens for this and patches its numbers in
// place instead of relying on the initial one-time fetch. The backend
// (Prisma/PostgreSQL) remains the source of truth — this is purely a UI
// nudge, not something the frontend trusts for anything security-relevant.
export const notifyJoinCodeUsageUpdated = ({ circleId, ownerId, uses, maxUses }) => {
  emitToUser(ownerId, "join-code:usage-updated", { circleId, uses, maxUses });
};
