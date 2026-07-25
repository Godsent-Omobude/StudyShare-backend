import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  const { fullName, username, password } = req.body;

  try {
    if (!username || !username.toUpperCase().startsWith('BMS')) {
      return res.status(400).json({ message: 'Access denied: Invalid matriculation number.' });
    }

    const normalizedUsername = username.toUpperCase();

    // Prisma unique checks
    const userExists = await prisma.user.findUnique({
      where: { username: normalizedUsername }
    });
    
    if (userExists) return res.status(400).json({ message: 'User already registered.' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await prisma.user.create({
      data: {
        fullName,
        username: normalizedUsername,
        password: hashedPassword
      }
    });

    const token = jwt.sign(
      { id: user.id, fullName: user.fullName, role: user.role }, 
      process.env.JWT_SECRET, 
      { expiresIn: '7d' }
    );
    
    res.status(201).json({ token, fullName: user.fullName });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    if (!username || !username.toUpperCase().startsWith('BMS')) {
      return res.status(400).json({ message: 'Access denied: Invalid matriculation number.' });
    }

    const user = await prisma.user.findUnique({
      where: { username: username.toUpperCase() }
    });
    
    if (!user) return res.status(400).json({ message: 'Invalid credentials.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials.' });

    const token = jwt.sign(
      { id: user.id, fullName: user.fullName, role: user.role }, 
      process.env.JWT_SECRET, 
      { expiresIn: '7d' }
    );
    
    res.json({ token, fullName: user.fullName });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
