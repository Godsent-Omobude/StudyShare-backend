import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';
import { getAuthCookie, setAuthCookie } from '../utils/cookies.js';

export const verifyAccessToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

export const getAuthenticatedUser = async (userId) => prisma.user.findUnique({
  where: { id: Number(userId) },
  select: {
    id: true, fullName: true, username: true, email: true, matricNumber: true,
    profilePicture: true, showUsernameOnMaterials: true, theme: true, accentColor: true, role: true,
  },
});

export const protect = async (req, res, next) => {
  const token = getAuthCookie(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authorised. No token provided.' });
  }

  try {
    const decoded = verifyAccessToken(token);

    // Check the token's embedded tokenVersion against the current stored
    // value. Password change/reset bumps the stored value, so this is how
    // a stolen or otherwise-compromised token gets invalidated immediately
    // instead of staying valid until it naturally expires. Queried
    // separately (not via getAuthenticatedUser) so tokenVersion is never
    // accidentally included in a response sent back to a client.
    const tokenRecord = await prisma.user.findUnique({
      where: { id: Number(decoded.id) },
      select: { tokenVersion: true },
    });

    if (!tokenRecord || (decoded.tokenVersion ?? 0) !== tokenRecord.tokenVersion) {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }

    req.user = await getAuthenticatedUser(decoded.id);
    if (!req.user) return res.status(401).json({ message: 'User not found.' });

    // Reset the 15-minute idle window since the user just made a request.
    setAuthCookie(res, token);

    return next();
  } catch {
    return res.status(401).json({ message: 'Not authorised. Invalid token.' });
  }
};
