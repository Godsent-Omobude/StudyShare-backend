import prisma from "../config/prisma.js";
import { getMembership, canManage } from "../services/circleAccess.js";
import { createNotification, notifyCircleManagers, notifyJoinCodeUsageUpdated } from "../services/circleRealtime.js";
import { createCircleMessage } from "../services/circleMessages.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
const CODE_LENGTH = 7;

const generateCode = () => {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
};

const generateUniqueJoinCode = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateCode();
    // eslint-disable-next-line no-await-in-loop
    const existing = await prisma.studyCircle.findUnique({ where: { joinCode: code } });
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique join code. Please try again.");
};

const memberCountFor = async (circleId) =>
  prisma.circleMember.count({ where: { circleId } });

const parseId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isNaN(id) ? null : id;
};

const stripJoinCodeManagement = (circle) => {
  const { joinCode, joinCodeEnabled, joinCodeExpiresAt, joinCodeMaxUses, joinCodeUses, joinCodeVersion, joinCodeRegeneratedAt, ...safe } = circle;
  return safe;
};

// ---------------------------------------------------------------------
// Circle lifecycle
// ---------------------------------------------------------------------

export const createCircle = async (req, res) => {
  try {
    const { name, courseCode, description, visibility } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Please give your circle a name." });
    }

    const normalizedVisibility = visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE";
    const joinCode = await generateUniqueJoinCode();

    const circle = await prisma.$transaction(async (tx) => {
      const created = await tx.studyCircle.create({
        data: {
          name: name.trim(),
          courseCode: courseCode ? courseCode.trim().toUpperCase() : null,
          description: description ? description.trim() : null,
          visibility: normalizedVisibility,
          joinCode,
          joinCodeEnabled: true,
          joinCodeUses: 0,
          joinCodeVersion: 1,
          ownerId: req.user.id,
        },
      });

      await tx.circleMember.create({
        data: {
          circleId: created.id,
          userId: req.user.id,
          role: "OWNER",
        },
      });

      return created;
    });

    return res.status(201).json({ ...circle, role: "OWNER", memberCount: 1 });
  } catch (error) {
    console.error("Create circle error:", error);
    return res.status(500).json({ message: error.message || "Unable to create circle." });
  }
};

export const getMyCircles = async (req, res) => {
  try {
    const memberships = await prisma.circleMember.findMany({
      where: { userId: req.user.id },
      include: {
        circle: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { joinedAt: "desc" },
    });

    const circles = memberships.map((m) => ({
      ...(m.role === "OWNER" ? m.circle : stripJoinCodeManagement(m.circle)),
      memberCount: m.circle._count.members,
      role: m.role,
    }));

    return res.json(circles);
  } catch (error) {
    console.error("Get my circles error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const discoverCircles = async (req, res) => {
  try {
    const search = (req.query.search || "").trim();

    const circles = await prisma.studyCircle.findMany({
      where: {
        visibility: "PUBLIC",
        ...(search
          ? {
              OR: [
                { name: { contains: search } },
                { courseCode: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        _count: { select: { members: true } },
        owner: { select: { username: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const circleIds = circles.map((c) => c.id);

    const [memberships, pendingRequests] = await Promise.all([
      prisma.circleMember.findMany({
        where: { userId: req.user.id, circleId: { in: circleIds } },
        select: { circleId: true },
      }),
      prisma.circleJoinRequest.findMany({
        where: {
          userId: req.user.id,
          circleId: { in: circleIds },
          status: "PENDING",
        },
        select: { circleId: true },
      }),
    ]);

    const memberSet = new Set(memberships.map((m) => m.circleId));
    const pendingSet = new Set(pendingRequests.map((r) => r.circleId));

    const results = circles.map(({ _count, owner, ...circle }) => ({
      ...stripJoinCodeManagement(circle),
      memberCount: _count.members,
      ownerUsername: owner.username,
      isMember: memberSet.has(circle.id),
      hasPendingRequest: pendingSet.has(circle.id),
    }));

    return res.json(results);
  } catch (error) {
    console.error("Discover circles error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const getCircle = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const circle = await prisma.studyCircle.findUnique({
      where: { id: circleId },
      include: { owner: { select: { username: true } } },
    });

    if (!circle) return res.status(404).json({ message: "Study Circle not found." });

    const membership = await getMembership(circleId, req.user.id);
    const memberCount = await memberCountFor(circleId);

    if (!membership && circle.visibility === "PRIVATE") {
      return res.status(403).json({
        message: "This circle is private. You need an invite or join code to view it.",
      });
    }

    if (!membership) {
      // Public, non-member preview
      const hasPendingRequest = await prisma.circleJoinRequest.findFirst({
        where: { circleId, userId: req.user.id, status: "PENDING" },
      });

      return res.json({
        ...stripJoinCodeManagement(circle),
        ownerUsername: circle.owner.username,
        memberCount,
        isMember: false,
        role: null,
        hasPendingRequest: !!hasPendingRequest,
      });
    }

    return res.json({
      ...(membership.role === "OWNER" ? circle : stripJoinCodeManagement(circle)),
      joinCode: membership.role === "OWNER" ? circle.joinCode : null,
      ownerUsername: circle.owner.username,
      memberCount,
      isMember: true,
      role: membership.role,
      joinCodeVisibleToOwner: membership.role === "OWNER",
    });
  } catch (error) {
    console.error("Get circle error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const leaveCircle = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) {
      return res.status(404).json({ message: "You are not a member of this circle." });
    }

    if (membership.role !== "OWNER") {
      await prisma.circleMember.delete({ where: { id: membership.id } });
      return res.json({ message: "You have left the circle." });
    }

    // Owner is leaving: hand ownership to the longest-standing moderator
    // (or member, if no moderator exists) if anyone else remains,
    // otherwise the circle is deleted since no one would be left.
    const otherMembers = await prisma.circleMember.findMany({
      where: { circleId, userId: { not: req.user.id } },
      orderBy: { joinedAt: "asc" },
    });

    if (!otherMembers.length) {
      await prisma.studyCircle.delete({ where: { id: circleId } });
      return res.json({ message: "You were the last member, so the circle was deleted." });
    }

    const newOwnerMembership =
      otherMembers.find((m) => m.role === "MODERATOR") || otherMembers[0];

    await prisma.$transaction([
      prisma.studyCircle.update({
        where: { id: circleId },
        data: { ownerId: newOwnerMembership.userId },
      }),
      prisma.circleMember.update({
        where: { id: newOwnerMembership.id },
        data: { role: "OWNER" },
      }),
      prisma.circleMember.delete({ where: { id: membership.id } }),
    ]);

    return res.json({ message: "Ownership was transferred and you left the circle." });
  } catch (error) {
    console.error("Leave circle error:", error);
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------
// Joining: join code (private) + search & request (public)
// ---------------------------------------------------------------------

export const joinByCode = async (req, res) => {
  try {
    const { joinCode } = req.body;
    if (!joinCode || !joinCode.trim()) return res.status(400).json({ message: "Please enter a join code." });

    const circle = await prisma.studyCircle.findUnique({ where: { joinCode: joinCode.trim().toUpperCase() } });
    if (!circle) return res.status(404).json({ message: "That join code doesn't match any circle." });
    const now = new Date();
    if (!circle.joinCodeEnabled) return res.status(400).json({ message: "This join code is disabled." });
    if (circle.joinCodeExpiresAt && circle.joinCodeExpiresAt <= now) return res.status(400).json({ message: "This join code has expired." });
    if (circle.joinCodeMaxUses != null && circle.joinCodeUses >= circle.joinCodeMaxUses) return res.status(400).json({ message: "This join code has reached its maximum uses." });

    const existing = await getMembership(circle.id, req.user.id);
    if (existing) return res.status(400).json({ message: "You're already a member of this circle." });

    const updatedCircle = await prisma.$transaction(async (tx) => {
      if (circle.joinCodeMaxUses != null) {
        const used = await tx.studyCircle.updateMany({ where: { id: circle.id, joinCodeEnabled: true, joinCodeVersion: circle.joinCodeVersion, joinCodeUses: { lt: circle.joinCodeMaxUses } }, data: { joinCodeUses: { increment: 1 } } });
        if (used.count !== 1) { const e = new Error("This join code has reached its maximum uses."); e.status = 400; throw e; }
      } else {
        const used = await tx.studyCircle.updateMany({ where: { id: circle.id, joinCodeEnabled: true, joinCodeVersion: circle.joinCodeVersion }, data: { joinCodeUses: { increment: 1 } } });
        if (used.count !== 1) { const e = new Error("This join code is no longer valid."); e.status = 400; throw e; }
      }
      await tx.circleMember.create({ data: { circleId: circle.id, userId: req.user.id, role: "MEMBER" } });
      // Read back the authoritative post-increment value from the same
      // transaction so the live update the owner receives can never be
      // stale or reflect a lost update from a concurrent joiner.
      return tx.studyCircle.findUnique({ where: { id: circle.id }, select: { joinCodeUses: true, joinCodeMaxUses: true, ownerId: true } });
    });

    notifyJoinCodeUsageUpdated({ circleId: circle.id, ownerId: updatedCircle.ownerId, uses: updatedCircle.joinCodeUses, maxUses: updatedCircle.joinCodeMaxUses });

    return res.status(201).json({ message: `You joined ${circle.name}.`, circleId: circle.id });
  } catch (error) {
    console.error("Join by code error:", error);
    return res.status(error.status || 500).json({ message: error.message });
  }
};

export const requestToJoin = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const circle = await prisma.studyCircle.findUnique({ where: { id: circleId } });
    if (!circle) return res.status(404).json({ message: "Study Circle not found." });

    if (circle.visibility !== "PUBLIC") {
      return res.status(400).json({
        message: "This circle is private. Ask a member for an invite or join code.",
      });
    }

    const existingMembership = await getMembership(circleId, req.user.id);
    if (existingMembership) {
      return res.status(400).json({ message: "You're already a member of this circle." });
    }

    const existingRequest = await prisma.circleJoinRequest.findFirst({
      where: { circleId, userId: req.user.id, status: "PENDING" },
    });
    if (existingRequest) {
      return res.status(400).json({ message: "You already have a pending request for this circle." });
    }

    const request = await prisma.circleJoinRequest.create({
      data: { circleId, userId: req.user.id },
    });

    await notifyCircleManagers({
      circleId, type: "CIRCLE_JOIN_REQUEST", title: "New Study Circle join request",
      body: `${req.user.username} requested to join ${circle.name}.`, actorUserId: req.user.id,
    });

    return res.status(201).json(request);
  } catch (error) {
    console.error("Request to join error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const listJoinRequests = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!canManage(membership)) {
      return res.status(403).json({ message: "Only the owner or moderators can view join requests." });
    }

    const requests = await prisma.circleJoinRequest.findMany({
      where: { circleId, status: "PENDING" },
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: "asc" },
    });

    return res.json(requests);
  } catch (error) {
    console.error("List join requests error:", error);
    return res.status(500).json({ message: error.message });
  }
};

const resolveJoinRequest = (approve) => async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const requestId = parseId(req.params.requestId);
    if (!circleId || !requestId) {
      return res.status(400).json({ message: "Invalid ID." });
    }

    const membership = await getMembership(circleId, req.user.id);
    if (!canManage(membership)) {
      return res.status(403).json({ message: "Only the owner or moderators can respond to join requests." });
    }

    const request = await prisma.circleJoinRequest.findUnique({ where: { id: requestId } });
    if (!request || request.circleId !== circleId || request.status !== "PENDING") {
      return res.status(404).json({ message: "Join request not found." });
    }

    if (approve) {
      const alreadyMember = await getMembership(circleId, request.userId);
      await prisma.$transaction([
        ...(alreadyMember
          ? []
          : [
              prisma.circleMember.create({
                data: { circleId, userId: request.userId, role: "MEMBER" },
              }),
            ]),
        prisma.circleJoinRequest.update({
          where: { id: requestId },
          data: { status: "APPROVED" },
        }),
      ]);
      await createNotification({ userId: request.userId, type: "CIRCLE_JOIN_APPROVED", title: "Join request approved", body: "Your Study Circle join request was approved.", circleId, actorUserId: req.user.id });
      return res.json({ message: "Request approved." });
    }

    await prisma.circleJoinRequest.update({
      where: { id: requestId },
      data: { status: "DECLINED" },
    });
    await createNotification({ userId: request.userId, type: "CIRCLE_JOIN_DECLINED", title: "Join request declined", body: "Your Study Circle join request was declined.", circleId, actorUserId: req.user.id });
    return res.json({ message: "Request declined." });
  } catch (error) {
    console.error("Resolve join request error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const approveJoinRequest = resolveJoinRequest(true);
export const declineJoinRequest = resolveJoinRequest(false);

// ---------------------------------------------------------------------
// Invites (owner + moderators, by username)
// ---------------------------------------------------------------------

export const sendInvite = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ message: "Please enter a username to invite." });
    }

    const membership = await getMembership(circleId, req.user.id);
    if (!canManage(membership)) {
      return res.status(403).json({ message: "Only the owner or moderators can send invites." });
    }
    const circle = await prisma.studyCircle.findUnique({ where: { id: circleId }, select: { name: true } });
    if (!circle) return res.status(404).json({ message: "Study Circle not found." });

    const targetUser = await prisma.user.findUnique({ where: { username: username.trim() } });
    if (!targetUser) {
      return res.status(404).json({ message: "No user found with that username." });
    }

    const alreadyMember = await getMembership(circleId, targetUser.id);
    if (alreadyMember) {
      return res.status(400).json({ message: "That user is already a member of this circle." });
    }

    const existingInvite = await prisma.circleInvite.findFirst({
      where: { circleId, invitedUserId: targetUser.id, status: "PENDING" },
    });
    if (existingInvite) {
      return res.status(400).json({ message: "An invite is already pending for this user." });
    }

    const invite = await prisma.circleInvite.create({
      data: {
        circleId,
        invitedUserId: targetUser.id,
        invitedByUserId: req.user.id,
      },
    });

    await createNotification({ userId: targetUser.id, type: "CIRCLE_INVITATION", title: "Study Circle invitation", body: `${req.user.username} invited you to ${circle.name}.`, circleId, actorUserId: req.user.id });

    return res.status(201).json(invite);
  } catch (error) {
    console.error("Send invite error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const listMyInvites = async (req, res) => {
  try {
    const invites = await prisma.circleInvite.findMany({
      where: { invitedUserId: req.user.id, status: "PENDING" },
      include: {
        circle: { select: { id: true, name: true, courseCode: true, visibility: true } },
        invitedByUser: { select: { username: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json(invites);
  } catch (error) {
    console.error("List my invites error:", error);
    return res.status(500).json({ message: error.message });
  }
};

const respondToInvite = (accept) => async (req, res) => {
  try {
    const inviteId = parseId(req.params.inviteId);
    if (!inviteId) return res.status(400).json({ message: "Invalid invite ID." });

    const invite = await prisma.circleInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.invitedUserId !== req.user.id || invite.status !== "PENDING") {
      return res.status(404).json({ message: "Invite not found." });
    }

    if (accept) {
      const alreadyMember = await getMembership(invite.circleId, req.user.id);
      await prisma.$transaction([
        ...(alreadyMember
          ? []
          : [
              prisma.circleMember.create({
                data: { circleId: invite.circleId, userId: req.user.id, role: "MEMBER" },
              }),
            ]),
        prisma.circleInvite.update({ where: { id: inviteId }, data: { status: "ACCEPTED" } }),
      ]);
      return res.json({ message: "Invite accepted.", circleId: invite.circleId });
    }

    await prisma.circleInvite.update({ where: { id: inviteId }, data: { status: "DECLINED" } });
    return res.json({ message: "Invite declined." });
  } catch (error) {
    console.error("Respond to invite error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const acceptInvite = respondToInvite(true);
export const declineInvite = respondToInvite(false);

// ---------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------

export const listMembers = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: "You must be a member to view this circle's members." });
    }

    const members = await prisma.circleMember.findMany({
      where: { circleId },
      include: { user: { select: { id: true, username: true } } },
      orderBy: [{ joinedAt: "asc" }],
    });

    // Owner first, then moderators, then members, preserving join order within each.
    const roleWeight = { OWNER: 0, MODERATOR: 1, MEMBER: 2 };
    members.sort((a, b) => roleWeight[a.role] - roleWeight[b.role]);

    return res.json(
      members.map((m) => ({
        userId: m.user.id,
        username: m.user.username,
        role: m.role,
        joinedAt: m.joinedAt,
      }))
    );
  } catch (error) {
    console.error("List members error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const updateMemberRole = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const targetUserId = parseId(req.params.userId);
    if (!circleId || !targetUserId) return res.status(400).json({ message: "Invalid ID." });

    const { role } = req.body;
    if (!["MODERATOR", "MEMBER"].includes(role)) {
      return res.status(400).json({ message: "Role must be MODERATOR or MEMBER." });
    }

    const membership = await getMembership(circleId, req.user.id);
    if (!membership || membership.role !== "OWNER") {
      return res.status(403).json({ message: "Only the circle owner can change member roles." });
    }

    if (targetUserId === req.user.id) {
      return res.status(400).json({ message: "You can't change your own role." });
    }

    const targetMembership = await getMembership(circleId, targetUserId);
    if (!targetMembership) {
      return res.status(404).json({ message: "That user is not a member of this circle." });
    }

    await prisma.circleMember.update({
      where: { id: targetMembership.id },
      data: { role },
    });

    return res.json({ message: "Member role updated." });
  } catch (error) {
    console.error("Update member role error:", error);
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------

export const getMessages = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(403).json({ message: "You must be a member to view this chat." });

    const after = parseId(req.query.after);
    const where = { circleId, ...(after ? { id: { gt: after } } : {}) };
    const messages = after
      ? await prisma.circleMessage.findMany({ where, include: { user: { select: { id: true, username: true } }, pinnedMessage: true }, orderBy: { id: "asc" } })
      : (await prisma.circleMessage.findMany({ where, include: { user: { select: { id: true, username: true } }, pinnedMessage: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 })).reverse();

    return res.json(messages.map((m) => ({ id: m.id, content: m.deletedAt ? null : m.content, createdAt: m.createdAt, editedAt: m.editedAt, deletedAt: m.deletedAt, userId: m.user.id, username: m.user.username, isPinned: !!m.pinnedMessage })));
  } catch (error) {
    console.error("Get messages error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });
    const message = await createCircleMessage(circleId, req.user.id, req.body.content);
    return res.status(201).json(message);
  } catch (error) {
    console.error("Send message error:", error);
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------

export const listSharedFiles = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: "You must be a member to view shared materials." });
    }

    // Enforce copyright access control here too, not just on the download
    // endpoint (section 18): a REMOVED file drops out of the shared-files
    // list entirely unless the requester owns it or is an admin. Applied
    // as a `where` clause (rather than fetched in full and filtered after)
    // so a circle with a long shared-materials history doesn't mean
    // pulling rows the requester isn't even allowed to see.
    const isAdmin = req.user.role === "admin";
    const shares = await prisma.circleSharedFile.findMany({
      where: {
        circleId,
        ...(isAdmin
          ? {}
          : {
              OR: [
                { file: { copyrightStatus: { not: "REMOVED" } } },
                { file: { uploadedBy: req.user.id } },
              ],
            }),
      },
      include: {
        file: true,
        sharedByUser: { select: { username: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const isOwnerOrAdmin = (file) => file.uploadedBy === req.user.id || isAdmin;

    return res.json(
      shares.map((s) => ({
        shareId: s.id,
        sharedAt: s.createdAt,
        sharedByUsername: s.sharedByUser.username,
        file: s.file,
        unavailable:
          !isOwnerOrAdmin(s.file) && !["CLEARED"].includes(s.file.copyrightStatus),
      }))
    );
  } catch (error) {
    console.error("List shared files error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const shareFile = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const fileId = parseId(req.body.fileId);
    if (!circleId || !fileId) {
      return res.status(400).json({ message: "Invalid circle or file ID." });
    }

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: "You must be a member to share materials here." });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file) return res.status(404).json({ message: "File not found." });

    const existing = await prisma.circleSharedFile.findUnique({
      where: { circleId_fileId: { circleId, fileId } },
    });
    if (existing) {
      return res.status(400).json({ message: "This material is already shared in the circle." });
    }

    const share = await prisma.circleSharedFile.create({
      data: { circleId, fileId, sharedByUserId: req.user.id },
    });

    return res.status(201).json(share);
  } catch (error) {
    console.error("Share file error:", error);
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------
// Circle flashcards (listing only — generation happens via /ai/flashcards
// with an optional circleId, see flashcardsController.js)
// ---------------------------------------------------------------------

export const listCircleFlashcards = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: "You must be a member to view this circle's flashcards." });
    }

    const sets = await prisma.flashcardSet.findMany({
      where: { circleId },
      include: {
        user: { select: { username: true } },
        _count: { select: { flashcards: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json(
      sets.map((s) => ({
        id: s.id,
        title: s.title,
        difficulty: s.difficulty,
        createdAt: s.createdAt,
        cardCount: s._count.flashcards,
        createdByUsername: s.user.username,
      }))
    );
  } catch (error) {
    console.error("List circle flashcards error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export { getMembership, canManage };
