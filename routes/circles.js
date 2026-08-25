import express from "express";
import { protect } from "../middleware/auth.js";
import {
  createCircle,
  getMyCircles,
  discoverCircles,
  getCircle,
  leaveCircle,
  joinByCode,
  requestToJoin,
  listJoinRequests,
  approveJoinRequest,
  declineJoinRequest,
  sendInvite,
  listMyInvites,
  acceptInvite,
  declineInvite,
  listMembers,
  updateMemberRole,
  getMessages,
  sendMessage,
  listSharedFiles,
  shareFile,
  listCircleFlashcards,
} from "../controllers/circlesController.js";
import { getJoinCodeSettings, updateJoinCodeSettings, regenerateJoinCode, disableJoinCode, enableJoinCode, createInvitationLink, joinByInvitationToken, previewInvitationToken } from "../controllers/circleCodeController.js";
import { editMessage, deleteMessage, pinMessage, unpinMessage, listPinnedMessages, removeMember } from "../controllers/circleMessageController.js";
import { listSessions, createSession, updateSession, deleteSession, rsvpSession } from "../controllers/circleSessionsController.js";
import { listNotes, createNote, updateNote, deleteNote } from "../controllers/circleNotesController.js";

const router = express.Router();

// Static/collection routes first, so they aren't shadowed by "/:id".
router.get("/mine", protect, getMyCircles);
router.get("/discover", protect, discoverCircles);
router.post("/join-by-code", protect, joinByCode);
router.get("/join/:token/preview", protect, previewInvitationToken);
router.post("/join/:token", protect, joinByInvitationToken);
router.get("/invites/mine", protect, listMyInvites);
router.post("/invites/:inviteId/accept", protect, acceptInvite);
router.post("/invites/:inviteId/decline", protect, declineInvite);

router.post("/", protect, createCircle);
router.get("/:id", protect, getCircle);
router.post("/:id/leave", protect, leaveCircle);

router.post("/:id/join-requests", protect, requestToJoin);
router.get("/:id/join-requests", protect, listJoinRequests);
router.post("/:id/join-requests/:requestId/approve", protect, approveJoinRequest);
router.post("/:id/join-requests/:requestId/decline", protect, declineJoinRequest);

router.post("/:id/invites", protect, sendInvite);

router.get("/:id/members", protect, listMembers);
router.patch("/:id/members/:userId", protect, updateMemberRole);
router.delete("/:id/members/:userId", protect, removeMember);

router.get("/:id/join-code", protect, getJoinCodeSettings);
router.patch("/:id/join-code", protect, updateJoinCodeSettings);
router.post("/:id/join-code/regenerate", protect, regenerateJoinCode);
router.post("/:id/join-code/disable", protect, disableJoinCode);
router.post("/:id/join-code/enable", protect, enableJoinCode);
router.post("/:id/invitation-link", protect, createInvitationLink);

router.get("/:id/messages", protect, getMessages);
router.post("/:id/messages", protect, sendMessage);
router.patch("/:id/messages/:messageId", protect, editMessage);
router.delete("/:id/messages/:messageId", protect, deleteMessage);
router.post("/:id/messages/:messageId/pin", protect, pinMessage);
router.delete("/:id/messages/:messageId/pin", protect, unpinMessage);
router.get("/:id/pinned-messages", protect, listPinnedMessages);

router.get("/:id/files", protect, listSharedFiles);
router.post("/:id/files", protect, shareFile);

router.get("/:id/flashcards", protect, listCircleFlashcards);

// Lightweight session scheduling ("study session Thursday 7pm").
router.get("/:id/sessions", protect, listSessions);
router.post("/:id/sessions", protect, createSession);
router.patch("/:id/sessions/:sessionId", protect, updateSession);
router.delete("/:id/sessions/:sessionId", protect, deleteSession);
router.post("/:id/sessions/:sessionId/rsvp", protect, rsvpSession);

// Shared notes/wiki, so useful info doesn't get buried in chat scrollback.
router.get("/:id/notes", protect, listNotes);
router.post("/:id/notes", protect, createNote);
router.patch("/:id/notes/:noteId", protect, updateNote);
router.delete("/:id/notes/:noteId", protect, deleteNote);

export default router;
