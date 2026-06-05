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
      const errCode = err.code || '';
      const errMsg = err.message || '';
      if (errCode === 'SQLITE_BUSY' || 
          errCode === 'SQLITE_ERROR' ||
          errMsg.includes('database is locked') ||
          errMsg.includes('cannot start a transaction within a transaction') ||
          errMsg.includes('SQLITE_BUSY')) {
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
    db.run('BEGIN IMMEDIATE TRANSACTION', async (beginErr) => {
      if (beginErr) {
        return reject(beginErr);
      }
      try {
        const result = await operations();
        db.run('COMMIT', (commitErr) => {
          if (commitErr) {
            db.run('ROLLBACK', () => reject(commitErr));
          } else {
            resolve(result);
          }
        });
      } catch (opErr) {
        db.run('ROLLBACK', (rollbackErr) => {
          if (rollbackErr) {
            reject(rollbackErr);
          } else {
            reject(opErr);
          }
        });
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
           (department_id, user_id, adjustment_type, amount, budget_before, budget_after, reason, is_reversed) 
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
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
      `SELECT ba.*, 
              d.name as department_name, 
              u.username as user_name,
              ru.username as reversed_by_name,
              ra.id as reversal_adjustment_id
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       LEFT JOIN users u ON ba.user_id = u.id
       LEFT JOIN users ru ON ba.reversed_by = ru.id
       LEFT JOIN budget_adjustments ra ON ra.reversal_of_id = ba.id
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

router.post('/:id/reverse', authenticate, requireFinance, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: '冲正原因不能为空' });
  }

  const reasonTrimmed = reason.trim();
  if (!reasonTrimmed) {
    return res.status(400).json({ error: '冲正原因不能为空' });
  }

  const adjId = parseInt(id);
  if (isNaN(adjId) || adjId <= 0) {
    return res.status(400).json({ error: '无效的调整记录ID' });
  }

  try {
    const originalAdjustment = await queryGet(
      `SELECT ba.*, d.name as department_name 
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       WHERE ba.id = ?`,
      [adjId]
    );

    if (!originalAdjustment) {
      return res.status(404).json({ error: '调整记录不存在' });
    }

    if (originalAdjustment.is_reversed) {
      return res.status(400).json({ error: '该调整记录已被冲正，不能重复冲正' });
    }

    if (originalAdjustment.adjustment_type === 'reversal') {
      return res.status(400).json({ error: '冲正记录本身不能被冲正' });
    }

    const dept = await queryGet('SELECT * FROM departments WHERE id = ?', [originalAdjustment.department_id]);
    if (!dept) {
      return res.status(404).json({ error: '部门不存在' });
    }

    const result = await executeWithRetry(async () => {
      return await runTransaction(async () => {
        const lockedAdj = await queryGet(
          'SELECT * FROM budget_adjustments WHERE id = ?',
          [adjId]
        );

        if (lockedAdj.is_reversed) {
          const error = new Error('该调整记录已被冲正，不能重复冲正');
          error.status = 400;
          throw error;
        }

        const lockedDept = await queryGet(
          'SELECT * FROM departments WHERE id = ?',
          [originalAdjustment.department_id]
        );

        const currentBudgetTotal = parseFloat(lockedDept.budget_total);
        const currentBudgetUsed = parseFloat(lockedDept.budget_used);
        const currentBudgetLocked = parseFloat(lockedDept.budget_locked);
        const originalAmount = parseFloat(lockedAdj.amount);

        let finalBudgetTotal;
        if (lockedAdj.adjustment_type === 'increase') {
          finalBudgetTotal = currentBudgetTotal - originalAmount;
        } else {
          finalBudgetTotal = currentBudgetTotal + originalAmount;
        }

        const minAllowed = currentBudgetUsed + currentBudgetLocked;
        if (finalBudgetTotal < minAllowed) {
          const error = new Error(
            `冲正后总预算不能低于已使用加锁定金额：${minAllowed.toFixed(2)}，冲正后将为：${finalBudgetTotal.toFixed(2)}`
          );
          error.status = 400;
          throw error;
        }

        if (finalBudgetTotal < 0) {
          const error = new Error('冲正后预算不能为负数');
          error.status = 400;
          throw error;
        }

        await runQuery(
          `UPDATE budget_adjustments 
           SET is_reversed = 1, reversed_by = ?, reversed_at = CURRENT_TIMESTAMP, reversal_reason = ?
           WHERE id = ?`,
          [req.user.id, reasonTrimmed, adjId]
        );

        await runQuery(
          'UPDATE departments SET budget_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [finalBudgetTotal, originalAdjustment.department_id]
        );

        const reversalAdjResult = await runQuery(
          `INSERT INTO budget_adjustments 
           (department_id, user_id, adjustment_type, amount, budget_before, budget_after, reason, is_reversed, reversal_of_id) 
           VALUES (?, ?, 'reversal', ?, ?, ?, ?, 0, ?)`,
          [
            originalAdjustment.department_id,
            req.user.id,
            originalAmount,
            currentBudgetTotal,
            finalBudgetTotal,
            reasonTrimmed,
            adjId
          ]
        );

        return { 
          reversalAdjustmentId: reversalAdjResult.lastID, 
          finalBudgetTotal, 
          currentBudgetTotal,
          originalAdjustmentId: adjId
        };
      });
    });

    const reversalAdjustment = await queryGet(
      `SELECT ba.*, 
              d.name as department_name, 
              u.username as user_name,
              ru.username as reversed_by_name,
              oa.id as original_adjustment_id,
              oa.reason as original_reason
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       LEFT JOIN users u ON ba.user_id = u.id
       LEFT JOIN users ru ON ba.reversed_by = ru.id
       LEFT JOIN budget_adjustments oa ON oa.id = ba.reversal_of_id
       WHERE ba.id = ?`,
      [result.reversalAdjustmentId]
    );

    const originalAdjustmentUpdated = await queryGet(
      `SELECT ba.*, 
              d.name as department_name, 
              u.username as user_name,
              ru.username as reversed_by_name
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       LEFT JOIN users u ON ba.user_id = u.id
       LEFT JOIN users ru ON ba.reversed_by = ru.id
       WHERE ba.id = ?`,
      [result.originalAdjustmentId]
    );

    const updatedDept = await queryGet(
      `SELECT d.*,
             (d.budget_total - d.budget_used - d.budget_locked) as budget_available
      FROM departments d WHERE d.id = ?`,
      [originalAdjustment.department_id]
    );

    res.json({
      reversalAdjustment,
      originalAdjustment: originalAdjustmentUpdated,
      department: updatedDept
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || '冲正失败' });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const { departmentId } = req.query;
    let sql = `
      SELECT ba.*, 
             d.name as department_name, 
             u.username as user_name,
             ru.username as reversed_by_name,
             ra.id as reversal_adjustment_id,
             oa.id as original_adjustment_id,
             oa.reason as original_reason
      FROM budget_adjustments ba
      LEFT JOIN departments d ON ba.department_id = d.id
      LEFT JOIN users u ON ba.user_id = u.id
      LEFT JOIN users ru ON ba.reversed_by = ru.id
      LEFT JOIN budget_adjustments ra ON ra.reversal_of_id = ba.id
      LEFT JOIN budget_adjustments oa ON oa.id = ba.reversal_of_id
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
      `SELECT ba.*, 
              d.name as department_name, 
              u.username as user_name,
              ru.username as reversed_by_name,
              ra.id as reversal_adjustment_id,
              oa.id as original_adjustment_id,
              oa.reason as original_reason
       FROM budget_adjustments ba
       LEFT JOIN departments d ON ba.department_id = d.id
       LEFT JOIN users u ON ba.user_id = u.id
       LEFT JOIN users ru ON ba.reversed_by = ru.id
       LEFT JOIN budget_adjustments ra ON ra.reversal_of_id = ba.id
       LEFT JOIN budget_adjustments oa ON oa.id = ba.reversal_of_id
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
