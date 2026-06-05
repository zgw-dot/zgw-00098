const express = require('express');
const db = require('../config/database');
const { authenticate, requireFinance } = require('../middleware/auth');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');

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
          errMsg.includes('database is locked') ||
          errMsg.includes('cannot start a transaction within a transaction') ||
          errMsg.includes('SQLITE_BUSY')) {
        await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)));
        continue;
      }
      if (err.status === 400 || err.status === 403 || err.status === 404 || err.status === 409) {
        throw err;
      }
      throw err;
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

const parseCSV = (csvText) => {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('CSV 文件至少需要包含表头和一行数据');
  }

  const headerLine = lines[0];
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

  const deptIdx = headers.findIndex(h => h.includes('部门') || h.includes('department'));
  const typeIdx = headers.findIndex(h => h.includes('类型') || h.includes('type'));
  const amountIdx = headers.findIndex(h => h.includes('金额') || h.includes('amount'));
  const reasonIdx = headers.findIndex(h => h.includes('原因') || h.includes('reason'));

  if (deptIdx === -1 || typeIdx === -1 || amountIdx === -1 || reasonIdx === -1) {
    throw new Error('CSV 表头必须包含：部门、类型、金额、原因');
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map(c => c.trim());
    rows.push({
      lineNumber: i,
      department: cols[deptIdx] || '',
      type: cols[typeIdx] || '',
      amount: cols[amountIdx] || '',
      reason: cols[reasonIdx] || ''
    });
  }

  return rows;
};

const validateRow = async (row, departmentsMap) => {
  const result = {
    lineNumber: row.lineNumber,
    department: row.department,
    type: row.type,
    amount: row.amount,
    reason: row.reason,
    valid: true,
    error: null,
    departmentId: null,
    amountNum: null,
    adjustmentType: null,
    currentBudget: null,
    budgetUsed: null,
    budgetLocked: null,
    expectedBudgetAfter: null
  };

  const dept = departmentsMap.get(row.department);
  if (!dept) {
    result.valid = false;
    result.error = `部门不存在: ${row.department}`;
    return result;
  }
  result.departmentId = dept.id;
  result.currentBudget = parseFloat(dept.budget_total);
  result.budgetUsed = parseFloat(dept.budget_used);
  result.budgetLocked = parseFloat(dept.budget_locked);

  const typeLower = row.type.toLowerCase().trim();
  if (typeLower === '追加' || typeLower === 'increase' || typeLower === '+') {
    result.adjustmentType = 'increase';
  } else if (typeLower === '调减' || typeLower === 'decrease' || typeLower === '-') {
    result.adjustmentType = 'decrease';
  } else {
    result.valid = false;
    result.error = `无效的调整类型: ${row.type}，必须是追加/increase 或调减/decrease`;
    return result;
  }

  const amountNum = parseFloat(row.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    result.valid = false;
    result.error = `金额必须为正数: ${row.amount}`;
    return result;
  }
  result.amountNum = amountNum;

  const reasonTrimmed = row.reason.trim();
  if (!reasonTrimmed) {
    result.valid = false;
    result.error = '原因不能为空';
    return result;
  }

  if (result.adjustmentType === 'increase') {
    result.expectedBudgetAfter = result.currentBudget + amountNum;
  } else {
    result.expectedBudgetAfter = result.currentBudget - amountNum;
    const minAllowed = result.budgetUsed + result.budgetLocked;
    if (result.expectedBudgetAfter < minAllowed) {
      result.valid = false;
      result.error = `调减后预算 (${result.expectedBudgetAfter.toFixed(2)}) 低于已使用 (${result.budgetUsed.toFixed(2)}) 加锁定金额 (${result.budgetLocked.toFixed(2)}) = ${minAllowed.toFixed(2)}`;
      return result;
    }
  }

  if (result.expectedBudgetAfter < 0) {
    result.valid = false;
    result.error = `调整后预算不能为负数: ${result.expectedBudgetAfter.toFixed(2)}`;
    return result;
  }

  return result;
};

router.post('/precheck', authenticate, requireFinance, async (req, res) => {
  try {
    const { csvText, rows, batchId } = req.body;

    if (!csvText && !rows) {
      return res.status(400).json({ error: '请提供 CSV 内容或数据行' });
    }

    let parsedRows;
    if (csvText) {
      parsedRows = parseCSV(csvText);
    } else {
      parsedRows = rows.map((r, i) => ({
        lineNumber: i + 1,
        department: r.department,
        type: r.type,
        amount: r.amount,
        reason: r.reason
      }));
    }

    if (parsedRows.length === 0) {
      return res.status(400).json({ error: '没有有效的数据行' });
    }

    const departments = await queryAll('SELECT * FROM departments');
    const departmentsMap = new Map();
    for (const dept of departments) {
      departmentsMap.set(dept.name, dept);
      departmentsMap.set(dept.id.toString(), dept);
    }

    const validationResults = [];
    let allValid = true;
    let totalAmount = 0;

    for (const row of parsedRows) {
      const result = await validateRow(row, departmentsMap);
      validationResults.push(result);
      if (!result.valid) {
        allValid = false;
      } else {
        totalAmount += result.amountNum;
      }
    }

    const response = {
      batchId: batchId || `BATCH-${Date.now()}`,
      totalRows: parsedRows.length,
      validRows: validationResults.filter(r => r.valid).length,
      invalidRows: validationResults.filter(r => !r.valid).length,
      allValid,
      totalAmount: parseFloat(totalAmount.toFixed(2)),
      results: validationResults.map(r => ({
        lineNumber: r.lineNumber,
        department: r.department,
        departmentId: r.departmentId,
        type: r.type,
        adjustmentType: r.adjustmentType,
        amount: r.amount,
        amountNum: r.amountNum,
        reason: r.reason,
        valid: r.valid,
        error: r.error,
        currentBudget: r.currentBudget,
        budgetUsed: r.budgetUsed,
        budgetLocked: r.budgetLocked,
        expectedBudgetAfter: r.expectedBudgetAfter
      }))
    };

    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/submit', authenticate, requireFinance, async (req, res) => {
  const { batchId, rows } = req.body;

  if (!batchId) {
    return res.status(400).json({ error: '缺少批次号 batchId' });
  }

  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: '没有数据行' });
  }

  try {
    const departments = await queryAll('SELECT * FROM departments');
    const departmentsMap = new Map();
    for (const dept of departments) {
      departmentsMap.set(dept.name, dept);
      departmentsMap.set(dept.id.toString(), dept);
    }

    const validationResults = [];
    let allValid = true;

    for (const row of rows) {
      const result = await validateRow({
        lineNumber: row.lineNumber,
        department: row.department,
        type: row.type,
        amount: row.amount,
        reason: row.reason
      }, departmentsMap);
      validationResults.push(result);
      if (!result.valid) {
        allValid = false;
      }
    }

    if (!allValid) {
      const failedBatch = await executeWithRetry(async () => {
        return await runTransaction(async () => {
          const existingBatchLocked = await queryGet(
            'SELECT * FROM budget_batches WHERE batch_id = ?',
            [batchId]
          );

          if (existingBatchLocked) {
            const error = new Error(`批次 ${batchId} 已存在`);
            error.status = 409;
            error.batchStatus = existingBatchLocked.status;
            throw error;
          }

          await runQuery(
            `INSERT INTO budget_batches 
             (batch_id, user_id, status, total_rows, success_rows, failed_rows, total_amount, error_message)
             VALUES (?, ?, 'failed', ?, 0, ?, 0, ?)`,
            [
              batchId,
              req.user.id,
              rows.length,
              validationResults.filter(r => !r.valid).length,
              '预检不通过，存在校验错误'
            ]
          );

          for (const result of validationResults) {
            await runQuery(
              `INSERT INTO budget_batch_lines
               (batch_id, line_number, department_id, department_name, adjustment_type, amount, reason, status, validation_error)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'invalid', ?)`,
              [
                batchId,
                result.lineNumber,
                result.departmentId || null,
                result.department,
                result.adjustmentType || null,
                result.amountNum || null,
                result.reason,
                result.error
              ]
            );
          }

          await runQuery(
            'UPDATE budget_batches SET updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?',
            [batchId]
          );

          return { batchId, validationResults };
        });
      });

      return res.status(400).json({
        error: '预检不通过，存在校验错误，整批拒绝',
        batchId,
        totalRows: rows.length,
        validRows: validationResults.filter(r => r.valid).length,
        invalidRows: validationResults.filter(r => !r.valid).length,
        results: validationResults.map(r => ({
          lineNumber: r.lineNumber,
          department: r.department,
          type: r.type,
          amount: r.amount,
          reason: r.reason,
          valid: r.valid,
          error: r.error
        }))
      });
    }

    const result = await executeWithRetry(async () => {
      return await runTransaction(async () => {
        const existingBatchLocked = await queryGet(
          'SELECT * FROM budget_batches WHERE batch_id = ?',
          [batchId]
        );

        if (existingBatchLocked) {
          const error = new Error(`批次 ${batchId} 已存在，不能重复提交`);
          error.status = 409;
          error.batchStatus = existingBatchLocked.status;
          throw error;
        }

        const deptBudgetChanges = new Map();

        for (const result of validationResults) {
          const deptId = result.departmentId;
          if (!deptBudgetChanges.has(deptId)) {
            const dept = await queryGet(
              'SELECT * FROM departments WHERE id = ?',
              [deptId]
            );
            deptBudgetChanges.set(deptId, {
              current: parseFloat(dept.budget_total),
              used: parseFloat(dept.budget_used),
              locked: parseFloat(dept.budget_locked),
              changes: []
            });
          }
          deptBudgetChanges.get(deptId).changes.push(result);
        }

        for (const [deptId, deptData] of deptBudgetChanges) {
          let runningTotal = deptData.current;
          for (const change of deptData.changes) {
            if (change.adjustmentType === 'increase') {
              runningTotal += change.amountNum;
            } else {
              runningTotal -= change.amountNum;
              const minAllowed = deptData.used + deptData.locked;
              if (runningTotal < minAllowed) {
                const error = new Error(
                  `第 ${change.lineNumber} 行: 累计调减后预算 (${runningTotal.toFixed(2)}) 低于已使用加锁定金额 (${minAllowed.toFixed(2)})`
                );
                error.status = 400;
                throw error;
              }
            }
            if (runningTotal < 0) {
              const error = new Error(`第 ${change.lineNumber} 行: 累计调整后预算不能为负数`);
              error.status = 400;
              throw error;
            }
            change.finalBudgetAfter = runningTotal;
          }
        }

        await runQuery(
          `INSERT INTO budget_batches 
           (batch_id, user_id, status, total_rows, success_rows, failed_rows, total_amount)
           VALUES (?, ?, 'submitted', ?, ?, 0, ?)`,
          [
            batchId,
            req.user.id,
            rows.length,
            rows.length,
            parseFloat(validationResults.reduce((sum, r) => sum + r.amountNum, 0).toFixed(2))
          ]
        );

        for (const result of validationResults) {
          const deptData = deptBudgetChanges.get(result.departmentId);
          let budgetBefore = deptData.current;

          const previousChanges = deptData.changes.filter(c => c.lineNumber < result.lineNumber);
          for (const prev of previousChanges) {
            if (prev.adjustmentType === 'increase') {
              budgetBefore += prev.amountNum;
            } else {
              budgetBefore -= prev.amountNum;
            }
          }

          const budgetAfter = result.finalBudgetAfter !== undefined
            ? result.finalBudgetAfter
            : (result.adjustmentType === 'increase'
                ? budgetBefore + result.amountNum
                : budgetBefore - result.amountNum);

          await runQuery(
            'UPDATE departments SET budget_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [budgetAfter, result.departmentId]
          );

          const adjResult = await runQuery(
            `INSERT INTO budget_adjustments 
             (department_id, user_id, adjustment_type, amount, budget_before, budget_after, reason, is_reversed, batch_id, batch_line)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [
              result.departmentId,
              req.user.id,
              result.adjustmentType,
              result.amountNum,
              budgetBefore,
              budgetAfter,
              result.reason.trim(),
              batchId,
              result.lineNumber
            ]
          );

          await runQuery(
            `INSERT INTO budget_batch_lines
             (batch_id, line_number, department_id, department_name, adjustment_type, amount, reason, status, budget_before, budget_after, adjustment_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
            [
              batchId,
              result.lineNumber,
              result.departmentId,
              result.department,
              result.adjustmentType,
              result.amountNum,
              result.reason.trim(),
              budgetBefore,
              budgetAfter,
              adjResult.lastID
            ]
          );
        }

        await runQuery(
          "UPDATE budget_batches SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?",
          [batchId]
        );

        return { validationResults, deptBudgetChanges };
      });
    });

    const batch = await queryGet(
      `SELECT bb.*, u.username as user_name
       FROM budget_batches bb
       LEFT JOIN users u ON bb.user_id = u.id
       WHERE bb.batch_id = ?`,
      [batchId]
    );

    const batchLines = await queryAll(
      `SELECT bl.*, d.name as department_name, u.username as user_name, ba.id as adjustment_id
       FROM budget_batch_lines bl
       LEFT JOIN departments d ON bl.department_id = d.id
       LEFT JOIN budget_adjustments ba ON ba.batch_id = bl.batch_id AND ba.batch_line = bl.line_number
       LEFT JOIN users u ON ba.user_id = u.id
       WHERE bl.batch_id = ?
       ORDER BY bl.line_number`,
      [batchId]
    );

    const updatedDepartments = await queryAll(`
      SELECT d.*,
             (d.budget_total - d.budget_used - d.budget_locked) as budget_available
      FROM departments d
      ORDER BY d.id
    `);

    res.json({
      success: true,
      message: '批次提交成功',
      batch,
      lines: batchLines,
      departments: updatedDepartments
    });
  } catch (err) {
    const status = err.status || 500;

    if (status === 409) {
      if (err.batchStatus === 'completed' || err.batchStatus === 'submitted') {
        return res.status(409).json({
          error: `批次 ${batchId} 已存在且已处理完成，不能重复提交`,
          batchId,
          status: err.batchStatus
        });
      }
      if (err.batchStatus === 'failed') {
        return res.status(409).json({
          error: `批次 ${batchId} 已存在但处理失败，请使用新的批次号`,
          batchId,
          status: err.batchStatus
        });
      }
      return res.status(409).json({
        error: err.message || `批次 ${batchId} 已存在，不能重复提交`,
        batchId
      });
    }

    if (status !== 409 && status >= 400) {
      try {
        const existingBatch = await queryGet(
          'SELECT * FROM budget_batches WHERE batch_id = ?',
          [batchId]
        );
        if (existingBatch) {
          await runQuery(
            "UPDATE budget_batches SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?",
            [err.message, batchId]
          );
        } else {
          await runQuery(
            `INSERT INTO budget_batches 
             (batch_id, user_id, status, total_rows, success_rows, failed_rows, total_amount, error_message)
             VALUES (?, ?, 'failed', ?, 0, ?, 0, ?)`,
            [
              batchId,
              req.user.id,
              rows.length,
              rows.length,
              err.message
            ]
          );
        }
      } catch (e) {
        console.error('更新批次状态失败:', e);
      }
    }

    res.status(status).json({ error: err.message || '批次提交失败' });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const { status, batchId } = req.query;
    let sql = `
      SELECT bb.*, u.username as user_name
      FROM budget_batches bb
      LEFT JOIN users u ON bb.user_id = u.id
    `;
    let params = [];
    let conditions = [];

    if (status) {
      conditions.push('bb.status = ?');
      params.push(status);
    }
    if (batchId) {
      conditions.push('bb.batch_id LIKE ?');
      params.push(`%${batchId}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY bb.created_at DESC';

    const batches = await queryAll(sql, params);

    res.json({ batches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:batchId', authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = await queryGet(
      `SELECT bb.*, u.username as user_name
       FROM budget_batches bb
       LEFT JOIN users u ON bb.user_id = u.id
       WHERE bb.batch_id = ?`,
      [batchId]
    );

    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }

    const lines = await queryAll(
      `SELECT bl.*, d.name as department_name, 
              ba.id as adjustment_id,
              ba.adjustment_type,
              ba.amount,
              ba.budget_before,
              ba.budget_after,
              ba.reason,
              u.username as operator_name
       FROM budget_batch_lines bl
       LEFT JOIN departments d ON bl.department_id = d.id
       LEFT JOIN budget_adjustments ba ON ba.batch_id = bl.batch_id AND ba.batch_line = bl.line_number
       LEFT JOIN users u ON ba.user_id = u.id
       WHERE bl.batch_id = ?
       ORDER BY bl.line_number`,
      [batchId]
    );

    res.json({ batch, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:batchId/export', authenticate, requireFinance, async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = await queryGet(
      `SELECT bb.*, u.username as user_name
       FROM budget_batches bb
       LEFT JOIN users u ON bb.user_id = u.id
       WHERE bb.batch_id = ?`,
      [batchId]
    );

    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }

    const lines = await queryAll(
      `SELECT bl.*, d.name as department_name, 
              ba.id as adjustment_id,
              ba.adjustment_type,
              ba.amount,
              ba.budget_before,
              ba.budget_after,
              ba.reason,
              u.username as operator_name
       FROM budget_batch_lines bl
       LEFT JOIN departments d ON bl.department_id = d.id
       LEFT JOIN budget_adjustments ba ON ba.batch_id = bl.batch_id AND ba.batch_line = bl.line_number
       LEFT JOIN users u ON ba.user_id = u.id
       WHERE bl.batch_id = ?
       ORDER BY bl.line_number`,
      [batchId]
    );

    const statusMap = {
      'pending': '待处理',
      'prechecked': '已预检',
      'submitted': '已提交',
      'completed': '已完成',
      'failed': '失败',
      'valid': '有效',
      'invalid': '无效'
    };

    const typeMap = {
      'increase': '追加预算',
      'decrease': '调减预算'
    };

    const exportDir = path.join(__dirname, '..', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `batch-${batchId}-${Date.now()}.csv`;
    const filepath = path.join(exportDir, filename);

    const csvWriter = createCsvWriter({
      path: filepath,
      header: [
        { id: 'batch_id', title: '批次号' },
        { id: 'line_number', title: '行号' },
        { id: 'department', title: '部门' },
        { id: 'adjustment_type', title: '调整类型' },
        { id: 'amount', title: '金额' },
        { id: 'budget_before', title: '调整前预算' },
        { id: 'budget_after', title: '调整后预算' },
        { id: 'reason', title: '原因' },
        { id: 'status', title: '状态' },
        { id: 'validation_error', title: '错误信息' },
        { id: 'adjustment_id', title: '调整记录ID' },
        { id: 'operator', title: '操作人' },
        { id: 'created_at', title: '创建时间' }
      ]
    });

    const records = lines.map(line => ({
      batch_id: batchId,
      line_number: line.line_number,
      department: line.department_name || line.department,
      adjustment_type: typeMap[line.adjustment_type] || line.adjustment_type,
      amount: parseFloat(line.amount).toFixed(2),
      budget_before: line.budget_before ? parseFloat(line.budget_before).toFixed(2) : '',
      budget_after: line.budget_after ? parseFloat(line.budget_after).toFixed(2) : '',
      reason: line.reason,
      status: statusMap[line.status] || line.status,
      validation_error: line.validation_error || '',
      adjustment_id: line.adjustment_id || '',
      operator: line.operator_name || batch.user_name,
      created_at: line.created_at
    }));

    await csvWriter.writeRecords(records);

    res.download(filepath, filename, (err) => {
      if (err) {
        res.status(500).json({ error: '导出失败' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
