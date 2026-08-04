const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Forbidden
    req.user = user;
    next();
  });
};

// Must run AFTER authenticateToken (which sets req.user with JWT claims).
// Checks that the token carries the required permission code.
function requirePermission(code) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    if (!perms.includes(code)) {
      return res.status(403).json({ error: `Missing permission: ${code}` });
    }
    next();
  };
}

module.exports = authenticateToken;
module.exports.requirePermission = requirePermission;
