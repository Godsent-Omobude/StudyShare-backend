/**
 * Allow access only to users whose database role is "admin".
 * Must be used after the protect middleware.
 */
export const admin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      message: "Not authorised. Please log in."
    });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({
      message: "Access denied. Administrator privileges required."
    });
  }

  next();
};
