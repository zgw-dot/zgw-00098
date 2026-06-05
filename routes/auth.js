const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { jwtSecret, jwtExpiresIn } = require('../config/config');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      return res.status(500).json({ error: '数据库错误' });
    }
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    bcrypt.compare(password, user.password_hash, (err, isValid) => {
      if (err) {
        return res.status(500).json({ error: '验证错误' });
      }
      if (!isValid) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: jwtExpiresIn });

      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          department: user.department
        }
      });
    });
  });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
