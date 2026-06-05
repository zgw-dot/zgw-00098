const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/config');
const db = require('../config/database');

const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    db.get('SELECT id, username, role, department FROM users WHERE id = ?', [decoded.userId], (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: '无效的认证令牌' });
      }
      req.user = user;
      next();
    });
  } catch (err) {
    return res.status(401).json({ error: '无效的认证令牌' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `需要以下角色之一: ${roles.join(', ')}` });
    }
    next();
  };
};

const requireApplicant = requireRole('applicant');
const requireSupervisor = requireRole('supervisor');
const requireFinance = requireRole('finance');
const requireSupervisorOrFinance = requireRole('supervisor', 'finance');

module.exports = {
  authenticate,
  requireRole,
  requireApplicant,
  requireSupervisor,
  requireFinance,
  requireSupervisorOrFinance
};
