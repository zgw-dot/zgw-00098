const express = require('express');
const db = require('../config/database');
const { authenticate, requireApplicant, requireSupervisor, requireFinance } = require('../middleware/auth');

const router = express.Router();

const getDepartmentByName = (name) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM departments WHERE name = ?', [name], (err, dept) => {
      if (err) reject(err);
      else resolve(dept);
    });
  });
};

const getApplicationById = (id) => {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT a.*, 
             u.username as applicant_name,
             s.username as supervisor_name,
             f.username as finance_name,
             d.name as department_name
      FROM applications a
      LEFT JOIN users u ON a.applicant_id = u.id
      LEFT JOIN users s ON a.supervisor_id = s.id
      LEFT JOIN users f ON a.finance_id = f.id
      LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `, [id], (err, app) => {
      if (err) reject(err);
      else resolve(app);
    });
  });
};

const addTimeline = (applicationId, userId, action, remark) => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO timeline (application_id, user_id, action, remark) VALUES (?, ?, ?, ?)',
      [applicationId, userId, action, remark],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
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

router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT a.*, 
             u.username as applicant_name,
             s.username as supervisor_name,
             f.username as finance_name,
             d.name as department_name
      FROM applications a
      LEFT JOIN users u ON a.applicant_id = u.id
      LEFT JOIN users s ON a.supervisor_id = s.id
      LEFT JOIN users f ON a.finance_id = f.id
      LEFT JOIN departments d ON a.department_id = d.id
    `;
    let params = [];

    if (req.user.role === 'applicant') {
      sql += ' WHERE a.applicant_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'supervisor') {
      sql += ' WHERE d.name = ?';
      params.push(req.user.department);
    }

    if (status) {
      sql += params.length ? ' AND' : ' WHERE';
      sql += ' a.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY a.created_at DESC';

    db.all(sql, params, (err, applications) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      res.json({ applications });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const app = await getApplicationById(req.params.id);
    if (!app) return res.status(404).json({ error: '申请不存在' });

    if (req.user.role === 'applicant' && app.applicant_id !== req.user.id) {
      return res.status(403).json({ error: '无权查看此申请' });
    }
    if (req.user.role === 'supervisor' && app.department_name !== req.user.department) {
      return res.status(403).json({ error: '无权查看此申请' });
    }

    db.all(`
      SELECT t.*, u.username as user_name
      FROM timeline t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.application_id = ?
      ORDER BY t.created_at ASC
    `, [req.params.id], (err, timeline) => {
      if (err) return res.status(500).json({ error: '查询时间线失败' });
      res.json({ application: app, timeline });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authenticate, requireApplicant, async (req, res) => {
  const { amount, supplier, purpose } = req.body;

  if (!amount || !supplier || !purpose) {
    return res.status(400).json({ error: '金额、供应商、用途不能为空' });
  }

  if (isNaN(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: '金额必须为正数' });
  }

  const amountNum = parseFloat(amount);

  try {
    const dept = await getDepartmentByName(req.user.department);
    if (!dept) return res.status(400).json({ error: '部门不存在' });

    const available = dept.budget_total - dept.budget_used - dept.budget_locked;
    if (amountNum > available) {
      return res.status(400).json({
        error: `预算不足，可用余额: ${available.toFixed(2)}，申请金额: ${amountNum.toFixed(2)}`
      });
    }

    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');

      try {
        const result = await runQuery(
          'INSERT INTO applications (applicant_id, department_id, amount, supplier, purpose, status) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.id, dept.id, amountNum, supplier, purpose, 'pending']
        );

        const appId = result.lastID;

        await runQuery(
          'UPDATE departments SET budget_locked = budget_locked + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [amountNum, dept.id]
        );

        await addTimeline(appId, req.user.id, 'submit', `提交采购申请，金额 ${amountNum.toFixed(2)}`);

        db.run('COMMIT', async (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: '提交失败' });
          }
          const app = await getApplicationById(appId);
          res.status(201).json({ application: app });
        });
      } catch (err) {
        db.run('ROLLBACK');
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', authenticate, requireSupervisor, async (req, res) => {
  const { remark } = req.body;

  try {
    const app = await getApplicationById(req.params.id);
    if (!app) return res.status(404).json({ error: '申请不存在' });

    if (app.status !== 'pending') {
      return res.status(400).json({ error: `当前状态 ${app.status} 不支持审批` });
    }

    if (app.department_name !== req.user.department) {
      return res.status(403).json({ error: '只能审批本部门的申请' });
    }

    if (app.applicant_id === req.user.id) {
      return res.status(403).json({ error: '不能审批自己提交的申请' });
    }

    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');

      try {
        await runQuery(
          'UPDATE applications SET status = ?, supervisor_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['approved', req.user.id, app.id]
        );

        await addTimeline(app.id, req.user.id, 'approve', remark || '主管审批通过');

        db.run('COMMIT', async (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: '审批失败' });
          }
          const updated = await getApplicationById(app.id);
          res.json({ application: updated });
        });
      } catch (err) {
        db.run('ROLLBACK');
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reject', authenticate, requireSupervisor, async (req, res) => {
  const { remark } = req.body;

  try {
    const app = await getApplicationById(req.params.id);
    if (!app) return res.status(404).json({ error: '申请不存在' });

    if (app.status !== 'pending') {
      return res.status(400).json({ error: `当前状态 ${app.status} 不支持驳回` });
    }

    if (app.department_name !== req.user.department) {
      return res.status(403).json({ error: '只能驳回本部门的申请' });
    }

    if (app.applicant_id === req.user.id) {
      return res.status(403).json({ error: '不能驳回自己提交的申请' });
    }

    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');

      try {
        await runQuery(
          'UPDATE applications SET status = ?, supervisor_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['rejected', req.user.id, app.id]
        );

        await runQuery(
          'UPDATE departments SET budget_locked = budget_locked - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [app.amount, app.department_id]
        );

        await addTimeline(app.id, req.user.id, 'reject', remark || '主管审批驳回，释放预算占用');

        db.run('COMMIT', async (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: '驳回失败' });
          }
          const updated = await getApplicationById(app.id);
          res.json({ application: updated });
        });
      } catch (err) {
        db.run('ROLLBACK');
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/withdraw', authenticate, requireApplicant, async (req, res) => {
  const { remark } = req.body;

  try {
    const app = await getApplicationById(req.params.id);
    if (!app) return res.status(404).json({ error: '申请不存在' });

    if (app.applicant_id !== req.user.id) {
      return res.status(403).json({ error: '只能撤回自己提交的申请' });
    }

    if (app.status === 'approved') {
      return res.status(400).json({ error: '已审批通过的申请不能撤回，请联系财务处理' });
    }

    if (app.status === 'withdrawn') {
      return res.status(400).json({ error: '申请已撤回，不能重复撤回' });
    }

    if (app.status === 'confirmed') {
      return res.status(400).json({ error: '已财务确认的申请不能撤回' });
    }

    if (app.status === 'rejected') {
      return res.status(400).json({ error: '已驳回的申请不能撤回' });
    }

    if (app.status !== 'pending') {
      return res.status(400).json({ error: `当前状态 ${app.status} 不支持撤回` });
    }

    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');

      try {
        await runQuery(
          'UPDATE applications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['withdrawn', app.id]
        );

        await runQuery(
          'UPDATE departments SET budget_locked = budget_locked - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [app.amount, app.department_id]
        );

        await addTimeline(app.id, req.user.id, 'withdraw', remark || '申请人撤回申请，释放预算占用');

        db.run('COMMIT', async (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: '撤回失败' });
          }
          const updated = await getApplicationById(app.id);
          res.json({ application: updated });
        });
      } catch (err) {
        db.run('ROLLBACK');
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/confirm', authenticate, requireFinance, async (req, res) => {
  const { remark } = req.body;

  try {
    const app = await getApplicationById(req.params.id);
    if (!app) return res.status(404).json({ error: '申请不存在' });

    if (app.status !== 'approved') {
      return res.status(400).json({ error: `当前状态 ${app.status} 不支持财务确认` });
    }

    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');

      try {
        await runQuery(
          'UPDATE applications SET status = ?, finance_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['confirmed', req.user.id, app.id]
        );

        await runQuery(
          'UPDATE departments SET budget_locked = budget_locked - ?, budget_used = budget_used + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [app.amount, app.amount, app.department_id]
        );

        await addTimeline(app.id, req.user.id, 'confirm', remark || '财务确认，预算正式占用');

        db.run('COMMIT', async (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: '财务确认失败' });
          }
          const updated = await getApplicationById(app.id);
          res.json({ application: updated });
        });
      } catch (err) {
        db.run('ROLLBACK');
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
