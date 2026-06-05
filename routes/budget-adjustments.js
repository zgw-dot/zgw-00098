const express = require('express');
const db = require('../config/database');
const { authenticate, requireFinance } = require('../middleware/auth');

const router = express.Router();

const queryGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const queryAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const runQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const executeWithRetry = async (fn, maxRetries = 10, delay = 200) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      const errMsg = err.message || '';
      if (errMsg.includes('database is locked') || 
          errMsg.includes('SQLITE_BUSY') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('connection') ||
          errMsg.includes('Cannot read properties')) {
        await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)));
        continue;
      }
      if (err.status === 400 || err.status === 403 || err.status === 404) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)));
    }
  }
};

const runTransaction = async (operations) => {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      db.run('BEGIN IMMEDIATE TRANSACTION');
      try {
        const result = await operations();
        db.run('COMMIT', (err) => {
          if (err) {
            db.run('ROLLBACK', () => reject(err));
          } else {
            resolve(result);
          }
        });
      } catch (err) {
        db.run('ROLLBACK', () => reject(err));
      }
    });
  });
};

router.post('/', authenticate, requireFinance, async (req, res) => {
  const { departmentId, adjustmentType, amount, reason } = req.body;

  if (!departmentId || !adjustmentType || !amount || !reason) {
    return res.status(400).json({ error: '部门ID、调整类型、调整金额、调整原因不能为空' });
  }

  if (!['increase', 'decrease'].includes(adjustmentType)) {
    return res.status(400).json({ error: '调整类型只能是 increase 或 decrease' });
  }

  if (isNaN(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: '调整金额必须为正数' });
  }

  const amountNum = parseFloat(amount);
  const reasonTrimmed = reason.trim();
  if (!reasonTrimmed) {
    return res.status(400).json({ error: '调整原因不能为空' });
  }

  try {
    const dept = await queryGet('SELECT * FROM departments WHERE id = ?', [departmentId]);
    if (!dept) {
      return res.status(404).json({ error: '部门不存在' });
    }

    const result = await executeWithRetry(async () => {
      return await runTransaction(async () => {
        const lockedDept = await queryGet(
          'SELECT * FROM departments WHERE id = ?',
          [departmentId]
        );

        const currentBudgetTotal = parseFloat(lockedDept.budget_total);
        const currentBudgetUsed = parseFloat(lockedDept.budget_used);
        const currentBudgetLocked = parseFloat(lockedDept.budget_locked);

        let finalBudgetTotal;
        if (adjustmentType === 'increase') {
          finalBudgetTotal = currentBudgetTotal + amountNum;
        } else {
          finalBudgetTotal = currentBudgetTotal - amountNum;
          const minAllowed = currentBudgetUsed + currentBudgetLocked;
          if (finalBudgetTotal < minAllowed) {
            const error = new Error(
              `调减后总预算不能低于已使用加锁定金额：${minAllowed.toFixed(2)}，调减后将为：${finalBudgetTotal.toFixed(2)}`
            );
            error.status = 400;
            throw error;
          }
        }

        if (finalBudgetTotal < 0) {
          const error = new Error('调整后预算不能为负数');
          error.status = 400;
          throw error;
        }

        await runQuery(
          'UPDATE departments SET budget_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [finalBudgetTotal, departmentId]
        );

        const adjResult = await runQuery(
          `INSERT INTO budget_adjustments 
           (department_id, user_id, adjustment_type, amount, budget_before, budget_after, reason) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            departmentId,
            req.user.id,
            adjustmentType,
            amountNum,
            currentBudgetTotal,
            finalBudgetTotal,
            reasonTrimmed
          ]
        );

        return { adjustmentId: adjResult.lastID, finalBudgetTotal, currentBudgetTotal };
      });
    });

    const adjustment = await queryGet(
      `SELECT ba.*, d.name as department_name, u.username as user_name 
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       LEFT JOIN users u ON ba.user_id = u.id
       WHERE ba.id = ?`,
      [result.adjustmentId]
    );

    const updatedDept = await queryGet(
      `SELECT d.*,
             (d.budget_total - d.budget_used - d.budget_locked) as budget_available
      FROM departments d WHERE d.id = ?`,
      [departmentId]
    );

    res.json({
      adjustment,
      department: updatedDept
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || '预算调整失败' });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const { departmentId } = req.query;
    let sql = `
      SELECT ba.*, d.name as department_name, u.username as user_name 
      FROM budget_adjustments ba
      LEFT JOIN departments d ON ba.department_id = d.id
      LEFT JOIN users u ON ba.user_id = u.id
    `;
    let params = [];

    if (departmentId) {
      sql += ' WHERE ba.department_id = ?';
      params.push(departmentId);
    }

    sql += ' ORDER BY ba.created_at DESC';

    const adjustments = await queryAll(sql, params);

    res.json({ adjustments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const adjustment = await queryGet(
      `SELECT ba.*, d.name as department_name, u.username as user_name 
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       LEFT JOIN users u ON ba.user_id = u.id
       WHERE ba.id = ?`,
      [req.params.id]
    );

    if (!adjustment) {
      return res.status(404).json({ error: '调整记录不存在' });
    }

    res.json({ adjustment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
