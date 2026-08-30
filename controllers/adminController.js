import fs from "fs/promises";
import path from "path";
import prisma from "../config/prisma.js";
import { deleteFromB2 } from "../services/b2Storage.js";

const safeUser = (user) => ({
  id: user.id,
  fullName: user.fullName,
  username: user.username,
  role: user.role,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  // Copyright standing — surfaced so User Management can show/act on it
  // without requiring the admin to already have one of this user's files
  // open in the Copyright Review Queue.
  copyrightWarnings: user.copyrightWarnings,
  suspendedUntil: user.suspendedUntil,
  suspendedReason: user.suspendedReason,
  terminatedAt: user.terminatedAt,
  terminatedReason: user.terminatedReason,
  _count: user._count
});

export const getAdminStats = async (req, res) => {
  try {
    const [users, admins, files, downloads, flashcardSets, flashcards] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { role: "admin" } }),
        prisma.file.count(),
        prisma.file.aggregate({ _sum: { downloads: true } }),
        prisma.flashcardSet.count(),
        prisma.flashcard.count()
      ]);

    const recentFiles = await prisma.file.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        type: true,
        courseCode: true,
        uploaderName: true,
        downloads: true,
        createdAt: true
      }
    });

    const recentUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fullName: true,
        username: true,
        role: true,
        createdAt: true
      }
    });

    res.json({
      success: true,
      stats: {
        users,
        admins,
        students: users - admins,
        files,
        downloads: downloads._sum.downloads || 0,
        flashcardSets,
        flashcards
      },
      recentFiles,
      recentUsers
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load administrator statistics."
    });
  }
};

export const getAdminUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fullName: true,
        username: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        copyrightWarnings: true,
        suspendedUntil: true,
        suspendedReason: true,
        terminatedAt: true,
        terminatedReason: true,
        _count: {
          select: {
            files: true,
            flashcardSets: true
          }
        }
      }
    });

    res.json({ success: true, users: users.map(safeUser) });
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load users."
    });
  }
};

export const updateUserRole = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: "Invalid user ID." });
    }

    if (!["student", "admin"].includes(role)) {
      return res.status(400).json({
        message: "Role must be either student or admin."
      });
    }

    if (userId === req.user.id && role !== "admin") {
      return res.status(400).json({
        message: "You cannot remove administrator access from your own account."
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (user.role === "admin" && role === "student") {
      const adminCount = await prisma.user.count({ where: { role: "admin" } });
      if (adminCount <= 1) {
        return res.status(400).json({
          message: "The last administrator cannot be demoted."
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: {
        id: true,
        fullName: true,
        username: true,
        role: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({
      success: true,
      message: `${updated.username} is now ${updated.role}.`,
      user: updated
    });
  } catch (error) {
    console.error("Update user role error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to update user role."
    });
  }
};

export const getAdminFiles = async (req, res) => {
  try {
    const files = await prisma.file.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        description: true,
        courseCode: true,
        type: true,
        filename: true,
        mimetype: true,
        uploaderName: true,
        uploadedBy: true,
        downloads: true,
        createdAt: true,
        updatedAt: true,
        copyrightConfirmedAt: true,
        copyrightConfirmationVersion: true,
        copyrightScanStatus: true,
        copyrightRiskScore: true,
        copyrightScanCheckedAt: true,
        // Canonical moderation status — the File Management table below
        // shows this so a hard-delete here isn't done blind to the fact
        // that the reversible Copyright Review flow may already be
        // handling this file (see the warning in deleteFile()).
        copyrightStatus: true,
        copyrightRisk: true,
        user: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      }
    });

    res.json({ success: true, files });
  } catch (error) {
    console.error("Admin files error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load uploaded files."
    });
  }
};

export const deleteAdminFile = async (req, res) => {
  try {
    const fileId = Number(req.params.id);

    if (!Number.isInteger(fileId)) {
      return res.status(400).json({ message: "Invalid file ID." });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });

    if (!file) {
      return res.status(404).json({ message: "File not found." });
    }

    await prisma.file.delete({ where: { id: fileId } });

    // Database deletion is the source of truth. Storage cleanup is
    // best-effort so a missing/already-gone object does not make the
    // admin action fail. Most files live in B2 (see routes/files.js
    // upload handler); only files uploaded before the B2 migration still
    // have a local "uploads/..." path.
    if (file.filepath?.startsWith("uploads/")) {
      try {
        await fs.unlink(path.resolve(file.filepath));
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn("Could not remove physical file:", error.message);
        }
      }
    } else if (file.filepath) {
      await deleteFromB2(file.filepath).catch((error) => {
        console.warn("Could not remove B2 object:", error.message);
      });
    }

    res.json({
      success: true,
      message: "File deleted successfully."
    });
  } catch (error) {
    console.error("Admin delete file error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to delete file."
    });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: "Invalid user ID." });
    }

    if (userId === req.user.id) {
      return res.status(400).json({
        message: "You cannot delete your own administrator account."
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        files: { select: { filepath: true } }
      }
    });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const fullUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });

    if (fullUser?.role === "admin") {
      const adminCount = await prisma.user.count({ where: { role: "admin" } });
      if (adminCount <= 1) {
        return res.status(400).json({
          message: "The last administrator cannot be deleted."
        });
      }
    }

    await prisma.user.delete({ where: { id: userId } });

    for (const file of user.files) {
      if (!file.filepath) continue;
      if (file.filepath.startsWith("uploads/")) {
        try {
          await fs.unlink(path.resolve(file.filepath));
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.warn("Could not remove user file:", error.message);
          }
        }
      } else {
        await deleteFromB2(file.filepath).catch((error) => {
          console.warn("Could not remove user's B2 object:", error.message);
        });
      }
    }

    res.json({
      success: true,
      message: `${user.username} has been deleted.`
    });
  } catch (error) {
    console.error("Admin delete user error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to delete user."
    });
  }
};
