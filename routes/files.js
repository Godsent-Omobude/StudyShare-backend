import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import prisma from '../config/prisma.js';
import { protect } from '../middleware/auth.js';
import { uploadToB2, getFromB2 } from '../services/b2Storage.js';

const router = express.Router();

// Multer stores the upload temporarily on the local filesystem.
// It is sent to Backblaze B2 immediately after upload and then removed.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`)
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    '.pdf',
    '.docx',
    '.pptx',
    '.ppt',
    '.png',
    '.jpg',
    '.jpeg'
  ];

  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        'Invalid file type. Only PDFs, Documents, Presentations, and Images are allowed.'
      )
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const createObjectKey = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const safeBase = path
    .basename(filename, ext)
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);

  return `documents/${randomUUID()}-${safeBase}${ext}`;
};

router.post('/upload', protect, upload.single('file'), async (req, res) => {
  const { title, description, courseCode, type } = req.body;

  if (!req.file) {
    return res.status(400).json({
      message: 'Please upload a physical file.'
    });
  }

  try {
    const objectKey = createObjectKey(req.file.originalname);

    // IMPORTANT: uploadToB2 expects an object containing these three values.
    // Passing the object as the first positional argument was the cause of:
    // "The path argument must be of type string... Received an instance of Object".
    await uploadToB2({
      filePath: req.file.path,
      objectKey,
      contentType: req.file.mimetype
    });

    const newFile = await prisma.file.create({
      data: {
        title,
        description,
        courseCode: courseCode ? courseCode.toUpperCase() : null,
        type,
        filename: req.file.originalname,
        // Store the B2 object key in SQLite. The PDF itself is NOT stored in SQLite.
        filepath: objectKey,
        mimetype: req.file.mimetype,
        uploadedBy: req.user.id,
        uploaderName: req.user.fullName
      }
    });

    // B2 and SQLite are both successful, so remove the temporary local copy.
    fs.unlink(req.file.path, (unlinkError) => {
      if (unlinkError) {
        console.error('Temporary upload cleanup error:', unlinkError);
      }
    });

    return res.status(201).json(newFile);
  } catch (error) {
    // Do not leave temporary files behind if B2 or SQLite fails.
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    console.error('File upload error:', error);

    return res.status(500).json({
      message: error.message || 'Unable to upload file.'
    });
  }
});

router.get('/', protect, async (req, res) => {
  try {
    const files = await prisma.file.findMany({
      orderBy: { createdAt: 'desc' }
    });

    return res.json(files);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/download/:id', protect, async (req, res) => {
  try {
    const fileId = Number.parseInt(req.params.id, 10);

    if (Number.isNaN(fileId)) {
      return res.status(400).json({ message: 'Invalid file ID.' });
    }

    const file = await prisma.file.findUnique({
      where: { id: fileId }
    });

    if (!file) {
      return res.status(404).json({ message: 'File not found.' });
    }

    // Backward compatibility for files that were uploaded before the B2 move.
    if (file.filepath.startsWith('uploads/') && fs.existsSync(file.filepath)) {
      await prisma.file.update({
        where: { id: fileId },
        data: { downloads: { increment: 1 } }
      });

      return res.download(
        file.filepath,
        file.title + path.extname(file.filename)
      );
    }

    // New files store their Backblaze B2 object key in filepath.
    const b2File = await getFromB2(file.filepath);

    await prisma.file.update({
      where: { id: fileId },
      data: { downloads: { increment: 1 } }
    });

    res.setHeader(
      'Content-Type',
      file.mimetype || 'application/octet-stream'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(
        file.title + path.extname(file.filename)
      )}`
    );

    if (b2File.ContentLength !== undefined) {
      res.setHeader('Content-Length', b2File.ContentLength);
    }

    b2File.Body.pipe(res);
  } catch (error) {
    console.error('B2 download error:', error);

    if (!res.headersSent) {
      return res.status(500).json({
        message: 'Unable to download this file.'
      });
    }

    res.end();
  }
});

export default router;
