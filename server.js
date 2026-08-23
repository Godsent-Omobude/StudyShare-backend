import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import aiRoutes from './routes/ai.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import circleRoutes from './routes/circles.js';
import notificationRoutes from './routes/notifications.js';
import { attachSocketServer } from './socket.js';
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
app.use('/api/settings', settingsRoutes);
app.use('/api/circles', circleRoutes);
app.use('/api/notifications', notificationRoutes);

const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);
attachSocketServer(httpServer);

// Test connection and boot application
async function main() {
  try {
    await prisma.$connect();
    console.log('PostgreSQL database connected successfully via Prisma ORM.');
    httpServer.listen(PORT, () => console.log(`Study2Gate Platform running on port ${PORT}`));
  } catch (e) {
    console.error('Database connection initialization failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
