import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';

export const verifyAccessToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

export const getAuthenticatedUser = async (userId) => prisma.user.findUnique({
  where: { id: Number(userId) },
  select: {
    id: true, fullName: true, username: true, email: true, matricNumber: true,
    profilePicture: true, showUsernameOnMaterials: true, theme: true, accentColor: true, role: true,
  },
});

export const protect = async (req, res, next) => {
  if (!req.headers.authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authorised. No token provided.' });
  }

  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = verifyAccessToken(token);
    req.user = await getAuthenticatedUser(decoded.id);
    if (!req.user) return res.status(401).json({ message: 'User not found.' });
    return next();
  } catch {
    return res.status(401).json({ message: 'Not authorised. Invalid token.' });
  }
};
