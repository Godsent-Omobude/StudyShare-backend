import express from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../config/prisma.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.pdf', '.docx', '.pptx', '.ppt', '.png', '.jpg', '.jpeg'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDFs, Documents, Presentations, and Images are allowed.'));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/upload', protect, upload.single('file'), async (req, res) => {
  const { title, description, courseCode, type } = req.body;
  if (!req.file) return res.status(400).json({ message: 'Please upload a physical file.' });

  try {
    const newFile = await prisma.file.create({
      data: {
        title,
        description,
        courseCode: courseCode ? courseCode.toUpperCase() : null,
        type,
        filename: req.file.filename,
        filepath: req.file.path,
        mimetype: req.file.mimetype,
        uploadedBy: req.user.id,
        uploaderName: req.user.fullName
      }
    });
    res.status(201).json(newFile);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/', protect, async (req, res) => {
  try {
    const files = await prisma.file.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(files);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/download/:id', protect, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);

    const file = await prisma.file.findUnique({
      where: { id: fileId }
    });
    
    if (!file) return res.status(404).json({ message: 'File not found' });

    // Atomic numerical increment using Prisma
    await prisma.file.update({
      where: { id: fileId },
      data: { downloads: { increment: 1 } }
    });

    res.download(file.filepath, file.title + path.extname(file.filename));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
