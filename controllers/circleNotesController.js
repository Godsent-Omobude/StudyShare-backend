import prisma from "../config/prisma.js";
import { getMembership, canManage } from "../services/circleAccess.js";
import { emitToCircle } from "../services/circleRealtime.js";

const parseId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isNaN(id) ? null : id;
};

const NOTE_INCLUDE = {
  createdByUser: { select: { username: true } },
  updatedByUser: { select: { username: true } }
};

// List every shared note for a circle — a lightweight wiki that keeps
// useful info out of the chat scrollback.
export const listNotes = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const notes = await prisma.circleNote.findMany({
      where: { circleId },
      include: NOTE_INCLUDE,
      orderBy: { updatedAt: "desc" }
    });

    return res.json(notes);
  } catch (error) {
    console.error("List circle notes error:", error);
    return res.status(500).json({ message: error.message || "Unable to load shared notes." });
  }
};

// Any member can start a new note.
export const createNote = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    if (!circleId) return res.status(400).json({ message: "Invalid circle ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const { title, content } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Please give the note a title." });
    }

    const note = await prisma.circleNote.create({
      data: {
        title: title.trim(),
        content: content?.toString() || "",
        circleId,
        createdByUserId: req.user.id
      },
      include: NOTE_INCLUDE
    });

    emitToCircle(circleId, "note:new", note);

    return res.status(201).json(note);
  } catch (error) {
    console.error("Create circle note error:", error);
    return res.status(500).json({ message: error.message || "Unable to create this note." });
  }
};

// Any member can edit — it's a shared wiki, not owner-locked content.
// Deletion is intentionally reserved for the author or a manager, so a
// stray member can't wipe out material other people rely on.
export const updateNote = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const noteId = parseId(req.params.noteId);
    if (!circleId || !noteId) return res.status(400).json({ message: "Invalid ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const existing = await prisma.circleNote.findFirst({ where: { id: noteId, circleId } });
    if (!existing) return res.status(404).json({ message: "Note not found." });

    const { title, content } = req.body;
    const data = { updatedByUserId: req.user.id };

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ message: "Title cannot be empty." });
      data.title = title.trim();
    }
    if (content !== undefined) data.content = content.toString();

    const note = await prisma.circleNote.update({
      where: { id: noteId },
      data,
      include: NOTE_INCLUDE
    });

    emitToCircle(circleId, "note:updated", note);

    return res.json(note);
  } catch (error) {
    console.error("Update circle note error:", error);
    return res.status(500).json({ message: error.message || "Unable to update this note." });
  }
};

export const deleteNote = async (req, res) => {
  try {
    const circleId = parseId(req.params.id);
    const noteId = parseId(req.params.noteId);
    if (!circleId || !noteId) return res.status(400).json({ message: "Invalid ID." });

    const membership = await getMembership(circleId, req.user.id);
    if (!membership) return res.status(404).json({ message: "Circle not found." });

    const existing = await prisma.circleNote.findFirst({ where: { id: noteId, circleId } });
    if (!existing) return res.status(404).json({ message: "Note not found." });

    if (existing.createdByUserId !== req.user.id && !canManage(membership)) {
      return res.status(403).json({ message: "You can't delete this note." });
    }

    await prisma.circleNote.delete({ where: { id: noteId } });

    emitToCircle(circleId, "note:deleted", { id: noteId });

    return res.json({ message: "Note deleted." });
  } catch (error) {
    console.error("Delete circle note error:", error);
    return res.status(500).json({ message: error.message || "Unable to delete this note." });
  }
};
