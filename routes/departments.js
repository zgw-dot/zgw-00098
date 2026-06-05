const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const queryAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

router.get('/', authenticate, async (req, res) => {
  try {
    const departments = await queryAll(`
      SELECT d.*,
             (d.budget_total - d.budget_used - d.budget_locked) as budget_available
      FROM departments d
      ORDER BY d.name
    `);

    const adjustmentCounts = await queryAll(`
      SELECT department_id, COUNT(*) as adjustment_count
      FROM budget_adjustments
      GROUP BY department_id
    `);

    const countMap = {};
    for (const ac of adjustmentCounts) {
      countMap[ac.department_id] = ac.adjustment_count;
    }

    const departmentsWithStats = departments.map(d => ({
      ...d,
      budget_total: parseFloat(d.budget_total),
      budget_used: parseFloat(d.budget_used),
      budget_locked: parseFloat(d.budget_locked),
      budget_available: parseFloat(d.budget_available),
      adjustment_count: countMap[d.id] || 0
    }));

    res.json({ departments: departmentsWithStats });
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

module.exports = router;
