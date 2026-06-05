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
      SELECT ba.*, 
             d.name as department_name, 
             u.username as user_name,
             ru.username as reversed_by_name,
             oa.adjustment_type as original_adjustment_type,
             oa.reason as original_reason
      FROM budget_adjustments ba
      LEFT JOIN departments d ON ba.department_id = d.id
      LEFT JOIN users u ON ba.user_id = u.id
      LEFT JOIN users ru ON ba.reversed_by = ru.id
      LEFT JOIN budget_adjustments oa ON oa.id = ba.reversal_of_id
      ORDER BY ba.created_at
    `);

    const initialBudgets = {
      1: 100000.00,
      2: 80000.00,
      3: 50000.00
    };

    const getAdjustmentDelta = (adj) => {
      const amount = parseFloat(adj.amount);
      if (adj.adjustment_type === 'increase') {
        return amount;
      } else if (adj.adjustment_type === 'decrease') {
        return -amount;
      } else if (adj.adjustment_type === 'reversal') {
        const originalType = adj.original_adjustment_type;
        if (originalType === 'increase') {
          return -amount;
        } else if (originalType === 'decrease') {
          return amount;
        }
      }
      return 0;
    };

    const getAdjustmentSymbol = (adj) => {
      if (adj.adjustment_type === 'increase') return '+';
      if (adj.adjustment_type === 'decrease') return '-';
      if (adj.adjustment_type === 'reversal') {
        const originalType = adj.original_adjustment_type;
        if (originalType === 'increase') return '-';
        if (originalType === 'decrease') return '+';
      }
      return '';
    };

    for (const adj of adjustments) {
      const budgetBefore = parseFloat(adj.budget_before);
      const budgetAfter = parseFloat(adj.budget_after);
      const amount = parseFloat(adj.amount);
      const delta = getAdjustmentDelta(adj);
      const expectedAfter = budgetBefore + delta;
      const symbol = getAdjustmentSymbol(adj);

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
        is_reversed: adj.is_reversed ? true : false,
        reversed_by_name: adj.reversed_by_name,
        reversed_at: adj.reversed_at,
        reversal_reason: adj.reversal_reason,
        reversal_of_id: adj.reversal_of_id,
        original_reason: adj.original_reason,
        amount_consistent: Math.abs(budgetAfter - expectedAfter) < 0.01
      };

      if (!adjResult.amount_consistent) {
        results.inconsistencies.push({
          type: 'budget_adjustment_mismatch',
          adjustment_id: adj.id,
          message: `预算调整 #${adj.id} 金额不一致: 调整前 ${budgetBefore.toFixed(2)} ${symbol} ${amount.toFixed(2)} 应为 ${expectedAfter.toFixed(2)}，实际 ${budgetAfter.toFixed(2)}`
        });
        results.overallConsistent = false;
      }

      results.budgetAdjustments.push(adjResult);
    }

    for (const dept of departments) {
      const deptAdjustments = adjustments.filter(a => a.department_id === dept.id);
      let calculatedTotal = initialBudgets[dept.id] || 0;
      for (const adj of deptAdjustments) {
        calculatedTotal += getAdjustmentDelta(adj);
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
    const totalAdjustmentsReversal = adjustments
      .filter(a => a.adjustment_type === 'reversal')
      .reduce((sum, a) => sum + parseFloat(a.amount), 0);
    const totalReversedCount = adjustments.filter(a => a.is_reversed).length;

    results.summary = {
      total_budget: totalExpected,
      total_used: totalUsed,
      total_locked: totalLocked,
      total_available: totalAvailable,
      application_count: applications.length,
      budget_adjustment_count: adjustments.length,
      total_adjustments_increase: parseFloat(totalAdjustmentsIncrease.toFixed(2)),
      total_adjustments_decrease: parseFloat(totalAdjustmentsDecrease.toFixed(2)),
      total_adjustments_reversal: parseFloat(totalAdjustmentsReversal.toFixed(2)),
      total_reversed_count: totalReversedCount,
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
             ba.is_reversed,
             ba.reversed_at,
             ba.reversal_reason,
             ba.reversal_of_id,
             d.name as department,
             u.username as operator,
             ru.username as reversed_by,
             oa.reason as original_reason,
             oa.created_at as original_created_at,
             ba.created_at
      FROM budget_adjustments ba
      LEFT JOIN departments d ON ba.department_id = d.id
      LEFT JOIN users u ON ba.user_id = u.id
      LEFT JOIN users ru ON ba.reversed_by = ru.id
      LEFT JOIN budget_adjustments oa ON oa.id = ba.reversal_of_id
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
      'decrease': '调减预算',
      'reversal': '冲正调整'
    };

    const getAmountDisplay = (adj) => {
      const amount = parseFloat(adj.amount).toFixed(2);
      if (adj.adjustment_type === 'increase') {
        return '+' + amount;
      } else if (adj.adjustment_type === 'decrease') {
        return '-' + amount;
      } else if (adj.adjustment_type === 'reversal') {
        if (adj.original_reason && adj.original_created_at) {
          const originalAdj = adjustments.find(a => a.id === adj.reversal_of_id);
          if (originalAdj && originalAdj.adjustment_type === 'increase') {
            return '-' + amount;
          } else {
            return '+' + amount;
          }
        }
        return '±' + amount;
      }
      return amount;
    };

    const getStatusDisplay = (adj) => {
      const baseType = typeMap[adj.adjustment_type] || adj.adjustment_type;
      if (adj.is_reversed) {
        return baseType + '(已冲正)';
      }
      return baseType;
    };

    const getReversalInfo = (adj) => {
      if (adj.adjustment_type === 'reversal' && adj.reversal_of_id) {
        return `冲正记录 #${adj.reversal_of_id}`;
      }
      if (adj.is_reversed && adj.reversed_by && adj.reversal_reason) {
        return `被 ${adj.reversed_by} 冲正，原因: ${adj.reversal_reason}`;
      }
      return '';
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
      reversal_info: '',
      reversed_by: '',
      reversed_at: '',
      reversal_reason: '',
      created_at: a.created_at,
      updated_at: a.updated_at
    }));

    const adjustmentRecords = adjustments.map(adj => {
      const amountDisplay = getAmountDisplay(adj);
      const statusDisplay = getStatusDisplay(adj);
      const reversalInfo = getReversalInfo(adj);
      const purposeDisplay = adj.adjustment_type === 'reversal' 
        ? `冲正调整 - ${adj.original_reason || '原调整'}`
        : typeMap[adj.adjustment_type] || adj.adjustment_type;

      return {
        record_type: '预算调整',
        id: adj.id,
        department: adj.department,
        applicant: '',
        amount: amountDisplay,
        supplier: '',
        purpose: purposeDisplay,
        status: statusDisplay,
        supervisor: '',
        finance: '',
        operator: adj.operator,
        budget_before: parseFloat(adj.budget_before).toFixed(2),
        budget_after: parseFloat(adj.budget_after).toFixed(2),
        reason: adj.reason,
        reversal_info: reversalInfo,
        reversed_by: adj.reversed_by || '',
        reversed_at: adj.reversed_at || '',
        reversal_reason: adj.reversal_reason || '',
        created_at: adj.created_at,
        updated_at: adj.created_at
      };
    });

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
        { id: 'reversal_info', title: '冲正关系' },
        { id: 'reversed_by', title: '冲正人' },
        { id: 'reversed_at', title: '冲正时间' },
        { id: 'reversal_reason', title: '冲正原因' },
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
