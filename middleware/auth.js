import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';
import { getAuthCookie, setAuthCookie } from '../utils/cookies.js';
import { hasAcceptedCurrentCopyrightPolicy } from '../utils/legalPolicy.js';

export const verifyAccessToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

const AUTH_USER_SELECT = {
  id: true, fullName: true, username: true, email: true, matricNumber: true,
  profilePicture: true, showUsernameOnMaterials: true, theme: true, accentColor: true, role: true,
  terminatedAt: true, suspendedUntil: true, suspendedReason: true,
  copyrightPolicyAcceptedAt: true, copyrightPolicyVersion: true,
};

export const getAuthenticatedUser = async (userId) => prisma.user.findUnique({
  where: { id: Number(userId) },
  select: AUTH_USER_SELECT,
});

// Combines the tokenVersion check and the user-profile fetch into a single
// query (previously two sequential round-trips on every authenticated
// request). tokenVersion is selected alongside the public fields but
// stripped off before the record is returned, so it's still never at risk
// of leaking into a response sent back to a client.
export const getAuthenticatedUserIfTokenValid = async (userId, tokenVersionFromToken) => {
  const record = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { ...AUTH_USER_SELECT, tokenVersion: true },
  });

  if (!record || (tokenVersionFromToken ?? 0) !== record.tokenVersion) {
    return null;
  }

  const { tokenVersion, ...user } = record;
  return user;
};

export const protect = async (req, res, next) => {
  const token = getAuthCookie(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authorised. No token provided.' });
  }

  try {
    const decoded = verifyAccessToken(token);

    // Checks the token's embedded tokenVersion against the current stored
    // value in the same query that loads the profile. Password change/reset
    // bumps the stored value, so this is how a stolen or otherwise-
    // compromised token gets invalidated immediately instead of staying
    // valid until it naturally expires.
    req.user = await getAuthenticatedUserIfTokenValid(decoded.id, decoded.tokenVersion);
    if (!req.user) {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }

    // Account-level copyright enforcement (see CopyrightAuditLog / admin
    // copyright actions). Checked on every request, not just login, so a
    // suspension/termination takes effect immediately for a user who is
    // already signed in with a valid token.
    if (req.user.terminatedAt) {
      return res.status(403).json({
        message: 'This account has been terminated.',
        code: 'ACCOUNT_TERMINATED',
      });
    }
    if (req.user.suspendedUntil && new Date(req.user.suspendedUntil) > new Date()) {
      return res.status(403).json({
        message: req.user.suspendedReason
          ? `This account is temporarily suspended: ${req.user.suspendedReason}`
          : 'This account is temporarily suspended.',
        code: 'ACCOUNT_SUSPENDED',
        suspendedUntil: req.user.suspendedUntil,
      });
    }

    // Mandatory Copyright Policy gate. Covers a session that was already
    // signed in when the policy (or its version) was introduced/updated —
    // login-time enforcement alone wouldn't catch that case since their
    // cookie is still otherwise valid.
    if (!hasAcceptedCurrentCopyrightPolicy(req.user)) {
      return res.status(403).json({
        message: 'Please review and accept the Copyright Policy to continue.',
        code: 'COPYRIGHT_POLICY_ACCEPTANCE_REQUIRED',
      });
    }

return next();
  } catch {
    return res.status(401).json({ message: 'Not authorised. Invalid token.' });
  }
};
