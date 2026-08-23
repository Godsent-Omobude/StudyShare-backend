import prisma from "../config/prisma.js";

export const getMembership = (circleId, userId) => prisma.circleMember.findUnique({
  where: { circleId_userId: { circleId, userId } },
});

export const canManage = (membership) =>
  !!membership && (membership.role === "OWNER" || membership.role === "MODERATOR");

export const canRemoveMember = (actorMembership, targetMembership, actorUserId) => {
  if (!actorMembership || !targetMembership || actorMembership.userId === targetMembership.userId) return false;
  if (targetMembership.role === "OWNER") return false;
  if (actorMembership.role === "OWNER") return true;
  return actorMembership.role === "MODERATOR" && targetMembership.role !== "MODERATOR";
};
