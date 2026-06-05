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

    for (const dept of departments) {
      const expectedLocked = applications
        .filter(a => a.department_id === dept.id && (a.status === 'pending' || a.status === 'approved'))
        .reduce((sum, a) => sum + parseFloat(a.amount), 0);

      const expectedUsed = applications
        .filter(a => a.department_id === dept.id && a.status === 'confirmed')
        .reduce((sum, a) => sum + parseFloat(a.amount), 0);

      const deptResult = {
        id: dept.id,
        name: dept.name,
        budget_total: parseFloat(dept.budget_total),
        budget_used: parseFloat(dept.budget_used),
        budget_locked: parseFloat(dept.budget_locked),
        expected_used: parseFloat(expectedUsed.toFixed(2)),
        expected_locked: parseFloat(expectedLocked.toFixed(2)),
        budget_available: parseFloat((dept.budget_total - dept.budget_used - dept.budget_locked).toFixed(2)),
        used_consistent: Math.abs(parseFloat(dept.budget_used) - expectedUsed) < 0.01,
        locked_consistent: Math.abs(parseFloat(dept.budget_locked) - expectedLocked) < 0.01
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

    results.summary = {
      total_budget: totalExpected,
      total_used: totalUsed,
      total_locked: totalLocked,
      total_available: totalAvailable,
      application_count: applications.length,
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

    const statusMap = {
      'pending': '待审批',
      'approved': '主管已批',
      'rejected': '已驳回',
      'withdrawn': '已撤回',
      'confirmed': '财务确认'
    };

    const records = applications.map(a => ({
      id: a.id,
      department: a.department,
      applicant: a.applicant,
      amount: a.amount,
      supplier: a.supplier,
      purpose: a.purpose,
      status: statusMap[a.status] || a.status,
      supervisor: a.supervisor || '',
      finance: a.finance || '',
      created_at: a.created_at,
      updated_at: a.updated_at
    }));

    const exportDir = path.join(__dirname, '..', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `budget-ledger-${Date.now()}.csv`;
    const filepath = path.join(exportDir, filename);

    const csvWriter = createCsvWriter({
      path: filepath,
      header: [
        { id: 'id', title: '申请编号' },
        { id: 'department', title: '部门' },
        { id: 'applicant', title: '申请人' },
        { id: 'amount', title: '金额' },
        { id: 'supplier', title: '供应商' },
        { id: 'purpose', title: '用途' },
        { id: 'status', title: '状态' },
        { id: 'supervisor', title: '审批主管' },
        { id: 'finance', title: '财务确认' },
        { id: 'created_at', title: '创建时间' },
        { id: 'updated_at', title: '更新时间' }
      ]
    });

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
