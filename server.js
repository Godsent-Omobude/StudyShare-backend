import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import aiRoutes from './routes/ai.js';
import adminRoutes from './routes/admin.js';
import prisma from './config/prisma.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

if (!fs.existsSync('uploads/ai')) {
  fs.mkdirSync('uploads/ai', { recursive: true });
}

app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin', adminRoutes);

const PORT = process.env.PORT || 5000;

// Test connection and boot application
async function main() {
  try {
    await prisma.$connect();
    console.log('PostgreSQL Database connected successfully via Prisma ORM.');
    app.listen(PORT, () => console.log(`StudyShare Platform running on port ${PORT}`));
  } catch (e) {
    console.error('Database connection initialization failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
