import { Server } from "socket.io";
import { getAuthenticatedUserIfTokenValid, verifyAccessToken } from "./middleware/auth.js";
import { getAuthCookie } from "./utils/cookies.js";
import { getMembership, canManage, canRemoveMember } from "./services/circleAccess.js";
import { setIO, circleRoom, userRoom, emitToCircle, createNotification, removeUserFromCircleSockets } from "./services/circleRealtime.js";
import { createCircleMessage, editCircleMessage, deleteCircleMessage, pinCircleMessage, unpinCircleMessage } from "./services/circleMessages.js";
import prisma from "./config/prisma.js";

export const attachSocketServer = (httpServer) => {
  const allowedOrigins = String(process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
          return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });
  setIO(io);

  io.use(async (socket, next) => {
    try {
      // The app authenticates entirely via an httpOnly cookie (see
      // middleware/auth.js) — there is no JWT ever exposed to client-side
      // JS for the frontend to hand over as socket.handshake.auth.token.
      // The Socket.IO client already connects with withCredentials: true,
      // so the same cookie that authenticates REST requests rides along
      // on the handshake; read it the same way `protect` does.
      const token = getAuthCookie({ headers: socket.handshake.headers });
      if (!token) return next(new Error("Authentication required."));
      const decoded = verifyAccessToken(token);

      const user = await getAuthenticatedUserIfTokenValid(decoded.id, decoded.tokenVersion);
      if (!user) return next(new Error("Session expired. Please log in again."));
      socket.user = user;
      return next();
    } catch {
      return next(new Error("Authentication failed."));
    }
  });

  io.on("connection", (socket) => {
    socket.join(userRoom(socket.user.id));

    socket.on("circle:join", async (circleId, ack = () => {}) => {
      try {
        const id = Number.parseInt(circleId, 10);
        if (!id) throw Object.assign(new Error("Invalid Circle ID."), { status: 400 });
        const membership = await getMembership(id, socket.user.id);
        if (!membership) throw Object.assign(new Error("You are not a member of this Circle."), { status: 403 });
        socket.join(circleRoom(id));
        ack({ ok: true, circleId: id, role: membership.role });
      } catch (error) { ack({ ok: false, message: error.message }); }
    });

    socket.on("circle:leave", (circleId) => {
      const id = Number.parseInt(circleId, 10);
      if (id) socket.leave(circleRoom(id));
    });

    const handle = (fn, ack = () => {}) => fn().then((payload) => ack({ ok: true, data: payload })).catch((error) => ack({ ok: false, message: error.message || "Operation failed." }));

    socket.on("message:send", (payload = {}, ack) => handle(() => createCircleMessage(Number(payload.circleId), socket.user.id, payload.content), ack));
    socket.on("message:edit", (payload = {}, ack) => handle(() => editCircleMessage(Number(payload.circleId), payload.messageId, socket.user.id, payload.content), ack));
    socket.on("message:delete", (payload = {}, ack) => handle(() => deleteCircleMessage(Number(payload.circleId), payload.messageId, socket.user.id), ack));
    socket.on("message:pin", (payload = {}, ack) => handle(() => pinCircleMessage(Number(payload.circleId), payload.messageId, socket.user.id), ack));
    socket.on("message:unpin", (payload = {}, ack) => handle(() => unpinCircleMessage(Number(payload.circleId), payload.messageId, socket.user.id), ack));

    socket.on("member:remove", async (payload = {}, ack = () => {}) => {
      try {
        const circleId = Number.parseInt(payload.circleId, 10);
        const targetUserId = Number.parseInt(payload.userId, 10);
        if (!circleId || !targetUserId) throw Object.assign(new Error("Invalid member information."), { status: 400 });
        const actor = await getMembership(circleId, socket.user.id);
        const target = await getMembership(circleId, targetUserId);
        if (!canRemoveMember(actor, target, socket.user.id)) throw Object.assign(new Error("You do not have permission to remove this member."), { status: 403 });
        await prisma.circleMember.delete({ where: { id: target.id } });
        removeUserFromCircleSockets(targetUserId, circleId);
        emitToCircle(circleId, "member:removed", { circleId, userId: targetUserId });
        await createNotification({ userId: targetUserId, type: "CIRCLE_MEMBER_REMOVED", title: "Removed from Study Circle", body: "You were removed from a Study Circle.", circleId, actorUserId: socket.user.id });
        ack({ ok: true });
      } catch (error) { ack({ ok: false, message: error.message || "Unable to remove member." }); }
    });

    socket.on("disconnect", () => {});
  });

  return io;
};
