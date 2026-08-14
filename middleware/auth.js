import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';

export const protect = async (req, res, next) => {
  let token;

  // Check if the request has a Bearer token
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      // Verify the token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Find the user in the database
      req.user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          fullName: true,
          username: true,
          email: true,
          matricNumber: true,
          profilePicture: true,
          showUsernameOnMaterials: true,
          theme: true,
          accentColor: true,
          role: true,
          showUsernameOnMaterials: true
        }
      });

      if (!req.user) {
        return res.status(401).json({ message: 'User not found.' });
      }

      next();
    } catch (error) {
      return res.status(401).json({ message: 'Not authorised. Invalid token.' });
    }
  } else {
    return res.status(401).json({ message: 'Not authorised. No token provided.' });
  }
};