const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, (req, res) => {
  db.all(`
    SELECT d.*,
           (d.budget_total - d.budget_used - d.budget_locked) as budget_available
    FROM departments d
    ORDER BY d.name
  `, [], (err, departments) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    res.json({ departments });
  });
});

module.exports = router;
