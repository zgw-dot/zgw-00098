const express = require('express');
const db = require('../config/database');
const { authenticate, requireFinance } = require('../middleware/auth');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');

const router = express.Router();

const queryAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const queryGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

router.get('/check', authenticate, async (req, res) => {
  try {
    const results = {
      timestamp: new Date().toISOString(),
      departments: [],
      applications: [],
      budgetAdjustments: [],
      inconsistencies: [],
      overallConsistent: true
    };

    const departments = await queryAll('SELECT * FROM departments ORDER BY id');
    const applications = await queryAll(`
      SELECT a.*, d.name as department_name
      FROM applications a
      LEFT JOIN departments d ON a.department_id = d.id
      ORDER BY a.id
    `);
    const adjustments = await queryAll(`
      SELECT ba.*, d.name as department_name, u.username as user_name
      FROM budget_adjustments ba
      LEFT JOIN departments d ON ba.department_id = d.id
      LEFT JOIN users u ON ba.user_id = u.id
      ORDER BY ba.created_at
    `);

    const initialBudgets = {
      1: 100000.00,
      2: 80000.00,
      3: 50000.00
    };

    for (const adj of adjustments) {
      const budgetBefore = parseFloat(adj.budget_before);
      const budgetAfter = parseFloat(adj.budget_after);
      const amount = parseFloat(adj.amount);
      const expectedAfter = adj.adjustment_type === 'increase'
        ? budgetBefore + amount
        : budgetBefore - amount;

      const adjResult = {
        id: adj.id,
        department: adj.department_name,
        adjustment_type: adj.adjustment_type,
        amount: amount,
        budget_before: budgetBefore,
        budget_after: budgetAfter,
        expected_after: parseFloat(expectedAfter.toFixed(2)),
        user_name: adj.user_name,
        reason: adj.reason,
        created_at: adj.created_at,
        amount_consistent: Math.abs(budgetAfter - expectedAfter) < 0.01
      };

      if (!adjResult.amount_consistent) {
        results.inconsistencies.push({
          type: 'budget_adjustment_mismatch',
          adjustment_id: adj.id,
          message: `预算调整 #${adj.id} 金额不一致: 调整前 ${budgetBefore.toFixed(2)} ${adj.adjustment_type === 'increase' ? '+' : '-'} ${amount.toFixed(2)} 应为 ${expectedAfter.toFixed(2)}，实际 ${budgetAfter.toFixed(2)}`
        });
        results.overallConsistent = false;
      }

      results.budgetAdjustments.push(adjResult);
    }

    for (const dept of departments) {
      const deptAdjustments = adjustments.filter(a => a.department_id === dept.id);
      let calculatedTotal = initialBudgets[dept.id] || 0;
      for (const adj of deptAdjustments) {
        if (adj.adjustment_type === 'increase') {
          calculatedTotal += parseFloat(adj.amount);
        } else {
          calculatedTotal -= parseFloat(adj.amount);
        }
      }
      dept.calculated_budget_total = parseFloat(calculatedTotal.toFixed(2));
    }

    for (const dept of departments) {
      const expectedLocked = applications
        .filter(a => a.department_id === dept.id && (a.status === 'pending' || a.status === 'approved'))
        .reduce((sum, a) => sum + parseFloat(a.amount), 0);

      const expectedUsed = applications
        .filter(a => a.department_id === dept.id && a.status === 'confirmed')
        .reduce((sum, a) => sum + parseFloat(a.amount), 0);

      const dbBudgetTotal = parseFloat(dept.budget_total);
      const deptResult = {
        id: dept.id,
        name: dept.name,
        budget_total: dbBudgetTotal,
        budget_used: parseFloat(dept.budget_used),
        budget_locked: parseFloat(dept.budget_locked),
        expected_used: parseFloat(expectedUsed.toFixed(2)),
        expected_locked: parseFloat(expectedLocked.toFixed(2)),
        calculated_budget_total: dept.calculated_budget_total,
        budget_available: parseFloat((dbBudgetTotal - dept.budget_used - dept.budget_locked).toFixed(2)),
        used_consistent: Math.abs(parseFloat(dept.budget_used) - expectedUsed) < 0.01,
        locked_consistent: Math.abs(parseFloat(dept.budget_locked) - expectedLocked) < 0.01,
        budget_total_consistent: Math.abs(dbBudgetTotal - dept.calculated_budget_total) < 0.01
      };

      if (!deptResult.used_consistent) {
        results.inconsistencies.push({
          type: 'budget_used_mismatch',
          department: dept.name,
          message: `已使用预算不一致: 数据库=${dept.budget_used}, 计算值=${expectedUsed.toFixed(2)}`
        });
        results.overallConsistent = false;
      }

      if (!deptResult.locked_consistent) {
        results.inconsistencies.push({
          type: 'budget_locked_mismatch',
          department: dept.name,
          message: `锁定预算不一致: 数据库=${dept.budget_locked}, 计算值=${expectedLocked.toFixed(2)}`
        });
        results.overallConsistent = false;
      }

      if (!deptResult.budget_total_consistent) {
        results.inconsistencies.push({
          type: 'budget_total_mismatch',
          department: dept.name,
          message: `总预算不一致: 数据库=${dbBudgetTotal.toFixed(2)}, 初始预算+调整计算值=${dept.calculated_budget_total.toFixed(2)}`
        });
        results.overallConsistent = false;
      }

      results.departments.push(deptResult);
    }

    for (const app of applications) {
      const timeline = await queryAll(
        'SELECT * FROM timeline WHERE application_id = ? ORDER BY id',
        [app.id]
      );

      const statusMap = {
        'submit': 'pending',
        'approve': 'approved',
        'reject': 'rejected',
        'withdraw': 'withdrawn',
        'confirm': 'confirmed'
      };

      const lastAction = timeline.length > 0 ? timeline[timeline.length - 1].action : null;
      const expectedStatus = lastAction ? statusMap[lastAction] : null;

      const appResult = {
        id: app.id,
        amount: parseFloat(app.amount),
        status: app.status,
        expected_status: expectedStatus,
        status_consistent: expectedStatus === app.status,
        timeline_count: timeline.length,
        timeline: timeline.map(t => ({
          action: t.action,
          user_id: t.user_id,
          remark: t.remark,
          created_at: t.created_at
        }))
      };

      if (!appResult.status_consistent) {
        results.inconsistencies.push({
          type: 'application_status_mismatch',
          application_id: app.id,
          message: `申请状态不一致: 数据库=${app.status}, 时间线最后动作=${lastAction}=>${expectedStatus}`
        });
        results.overallConsistent = false;
      }

      results.applications.push(appResult);
    }

    const totalExpected = departments.reduce((sum, d) => sum + parseFloat(d.budget_total), 0);
    const totalUsed = departments.reduce((sum, d) => sum + parseFloat(d.budget_used), 0);
    const totalLocked = departments.reduce((sum, d) => sum + parseFloat(d.budget_locked), 0);
    const totalAvailable = totalExpected - totalUsed - totalLocked;

    const totalAdjustmentsIncrease = adjustments
      .filter(a => a.adjustment_type === 'increase')
      .reduce((sum, a) => sum + parseFloat(a.amount), 0);
    const totalAdjustmentsDecrease = adjustments
      .filter(a => a.adjustment_type === 'decrease')
      .reduce((sum, a) => sum + parseFloat(a.amount), 0);

    results.summary = {
      total_budget: totalExpected,
      total_used: totalUsed,
      total_locked: totalLocked,
      total_available: totalAvailable,
      application_count: applications.length,
      budget_adjustment_count: adjustments.length,
      total_adjustments_increase: parseFloat(totalAdjustmentsIncrease.toFixed(2)),
      total_adjustments_decrease: parseFloat(totalAdjustmentsDecrease.toFixed(2)),
      status_breakdown: {
        pending: applications.filter(a => a.status === 'pending').length,
        approved: applications.filter(a => a.status === 'approved').length,
        rejected: applications.filter(a => a.status === 'rejected').length,
        withdrawn: applications.filter(a => a.status === 'withdrawn').length,
        confirmed: applications.filter(a => a.status === 'confirmed').length
      }
    };

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export', authenticate, requireFinance, async (req, res) => {
  try {
    const applications = await queryAll(`
      SELECT a.id,
             a.amount,
             a.status,
             a.supplier,
             a.purpose,
             u.username as applicant,
             s.username as supervisor,
             f.username as finance,
             d.name as department,
             a.created_at,
             a.updated_at
      FROM applications a
      LEFT JOIN users u ON a.applicant_id = u.id
      LEFT JOIN users s ON a.supervisor_id = s.id
      LEFT JOIN users f ON a.finance_id = f.id
      LEFT JOIN departments d ON a.department_id = d.id
      ORDER BY a.created_at DESC
    `);

    const adjustments = await queryAll(`
      SELECT ba.id,
             ba.adjustment_type,
             ba.amount,
             ba.budget_before,
             ba.budget_after,
             ba.reason,
             d.name as department,
             u.username as operator,
             ba.created_at
      FROM budget_adjustments ba
      LEFT JOIN departments d ON ba.department_id = d.id
      LEFT JOIN users u ON ba.user_id = u.id
      ORDER BY ba.created_at DESC
    `);

    const statusMap = {
      'pending': '待审批',
      'approved': '主管已批',
      'rejected': '已驳回',
      'withdrawn': '已撤回',
      'confirmed': '财务确认'
    };

    const typeMap = {
      'increase': '追加预算',
      'decrease': '调减预算'
    };

    const applicationRecords = applications.map(a => ({
      record_type: '采购申请',
      id: a.id,
      department: a.department,
      applicant: a.applicant,
      amount: a.amount,
      supplier: a.supplier,
      purpose: a.purpose,
      status: statusMap[a.status] || a.status,
      supervisor: a.supervisor || '',
      finance: a.finance || '',
      operator: '',
      budget_before: '',
      budget_after: '',
      reason: '',
      created_at: a.created_at,
      updated_at: a.updated_at
    }));

    const adjustmentRecords = adjustments.map(adj => ({
      record_type: '预算调整',
      id: adj.id,
      department: adj.department,
      applicant: '',
      amount: (adj.adjustment_type === 'decrease' ? '-' : '+') + parseFloat(adj.amount).toFixed(2),
      supplier: '',
      purpose: typeMap[adj.adjustment_type] || adj.adjustment_type,
      status: typeMap[adj.adjustment_type] || adj.adjustment_type,
      supervisor: '',
      finance: '',
      operator: adj.operator,
      budget_before: parseFloat(adj.budget_before).toFixed(2),
      budget_after: parseFloat(adj.budget_after).toFixed(2),
      reason: adj.reason,
      created_at: adj.created_at,
      updated_at: adj.created_at
    }));

    const allRecords = [...applicationRecords, ...adjustmentRecords].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );

    const exportDir = path.join(__dirname, '..', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `budget-ledger-${Date.now()}.csv`;
    const filepath = path.join(exportDir, filename);

    const csvWriter = createCsvWriter({
      path: filepath,
      header: [
        { id: 'record_type', title: '记录类型' },
        { id: 'id', title: '编号' },
        { id: 'department', title: '部门' },
        { id: 'applicant', title: '申请人' },
        { id: 'operator', title: '操作人' },
        { id: 'amount', title: '金额' },
        { id: 'budget_before', title: '调整前预算' },
        { id: 'budget_after', title: '调整后预算' },
        { id: 'supplier', title: '供应商' },
        { id: 'purpose', title: '用途/类型' },
        { id: 'reason', title: '调整原因' },
        { id: 'status', title: '状态' },
        { id: 'supervisor', title: '审批主管' },
        { id: 'finance', title: '财务确认' },
        { id: 'created_at', title: '创建时间' },
        { id: 'updated_at', title: '更新时间' }
      ]
    });

    await csvWriter.writeRecords(allRecords);

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
