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

    const adjustmentStats = await queryAll(`
      SELECT department_id, 
             COUNT(*) as total_count,
             SUM(CASE WHEN is_reversed = 1 THEN 1 ELSE 0 END) as reversed_count,
             SUM(CASE WHEN adjustment_type = 'reversal' THEN 1 ELSE 0 END) as reversal_count
      FROM budget_adjustments
      GROUP BY department_id
    `);

    const countMap = {};
    for (const as of adjustmentStats) {
      countMap[as.department_id] = {
        total: as.total_count,
        reversed: as.reversed_count,
        reversal: as.reversal_count,
        effective: as.total_count - as.reversal_count
      };
    }

    const departmentsWithStats = departments.map(d => {
      const stats = countMap[d.id] || { total: 0, reversed: 0, reversal: 0, effective: 0 };
      return {
        ...d,
        budget_total: parseFloat(d.budget_total),
        budget_used: parseFloat(d.budget_used),
        budget_locked: parseFloat(d.budget_locked),
        budget_available: parseFloat(d.budget_available),
        adjustment_count: stats.total,
        adjustment_stats: stats
      };
    });

    res.json({ departments: departmentsWithStats });
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

module.exports = router;
