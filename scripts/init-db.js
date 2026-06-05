const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'budget.db');
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log('旧数据库已删除');
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('applicant', 'supervisor', 'finance')),
      department TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('创建 users 表失败:', err);
    else console.log('✓ users 表创建成功');
  });

  db.run(`
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      budget_total DECIMAL(15,2) NOT NULL DEFAULT 0,
      budget_used DECIMAL(15,2) NOT NULL DEFAULT 0,
      budget_locked DECIMAL(15,2) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('创建 departments 表失败:', err);
    else console.log('✓ departments 表创建成功');
  });

  db.run(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      supplier TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'withdrawn', 'confirmed')),
      supervisor_id INTEGER,
      finance_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (applicant_id) REFERENCES users(id),
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (supervisor_id) REFERENCES users(id),
      FOREIGN KEY (finance_id) REFERENCES users(id)
    )
  `, (err) => {
    if (err) console.error('创建 applications 表失败:', err);
    else console.log('✓ applications 表创建成功');
  });

  db.run(`
    CREATE TABLE timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('submit', 'approve', 'reject', 'withdraw', 'confirm')),
      remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES applications(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `, (err) => {
    if (err) console.error('创建 timeline 表失败:', err);
    else console.log('✓ timeline 表创建成功');
  });

  db.run(`
    CREATE TABLE budget_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('increase', 'decrease', 'reversal')),
      amount DECIMAL(15,2) NOT NULL,
      budget_before DECIMAL(15,2) NOT NULL,
      budget_after DECIMAL(15,2) NOT NULL,
      reason TEXT NOT NULL,
      is_reversed INTEGER NOT NULL DEFAULT 0,
      reversed_by INTEGER,
      reversed_at DATETIME,
      reversal_reason TEXT,
      reversal_of_id INTEGER,
      batch_id TEXT,
      batch_line INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (reversed_by) REFERENCES users(id),
      FOREIGN KEY (reversal_of_id) REFERENCES budget_adjustments(id)
    )
  `, (err) => {
    if (err) console.error('创建 budget_adjustments 表失败:', err);
    else console.log('✓ budget_adjustments 表创建成功');
  });

  db.run(`
    CREATE TABLE budget_batches (
      batch_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'prechecked', 'submitted', 'failed', 'completed', 'cancelled')),
      total_rows INTEGER NOT NULL DEFAULT 0,
      success_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      error_message TEXT,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `, (err) => {
    if (err) console.error('创建 budget_batches 表失败:', err);
    else console.log('✓ budget_batches 表创建成功');
  });

  db.run(`
    CREATE TABLE budget_batch_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('precheck', 'submit', 'cancel', 'export')),
      remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES budget_batches(batch_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `, (err) => {
    if (err) console.error('创建 budget_batch_operations 表失败:', err);
    else console.log('✓ budget_batch_operations 表创建成功');
  });

  db.run(`
    CREATE TABLE budget_batch_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      department_id INTEGER,
      department_name TEXT,
      adjustment_type TEXT CHECK(adjustment_type IN ('increase', 'decrease')),
      amount DECIMAL(15,2),
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'valid', 'invalid', 'submitted', 'failed', 'cancelled')),
      validation_error TEXT,
      current_budget DECIMAL(15,2),
      expected_budget_after DECIMAL(15,2),
      budget_before DECIMAL(15,2),
      budget_after DECIMAL(15,2),
      adjustment_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES budget_batches(batch_id),
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (adjustment_id) REFERENCES budget_adjustments(id)
    )
  `, (err) => {
    if (err) console.error('创建 budget_batch_lines 表失败:', err);
    else console.log('✓ budget_batch_lines 表创建成功');
  });

  const stmtUser = db.prepare('INSERT INTO users (username, password_hash, role, department) VALUES (?, ?, ?, ?)');
  const stmtDept = db.prepare('INSERT INTO departments (name, budget_total) VALUES (?, ?)');

  stmtDept.run('技术部', 100000.00);
  stmtDept.run('市场部', 80000.00);
  stmtDept.run('财务部', 50000.00);
  stmtDept.finalize();

  const hash1 = bcrypt.hashSync('123456', 10);
  const hash2 = bcrypt.hashSync('123456', 10);
  const hash3 = bcrypt.hashSync('123456', 10);
  const hash4 = bcrypt.hashSync('123456', 10);
  const hash5 = bcrypt.hashSync('123456', 10);

  stmtUser.run('zhangsan', hash1, 'applicant', '技术部');
  stmtUser.run('lisi', hash2, 'applicant', '市场部');
  stmtUser.run('wangwu', hash3, 'supervisor', '技术部');
  stmtUser.run('zhaoliu', hash4, 'supervisor', '市场部');
  stmtUser.run('qianqi', hash5, 'finance', null);
  stmtUser.finalize();

  console.log('✓ 初始数据插入成功');
  console.log('');
  console.log('=== 测试账号 ===');
  console.log('申请人: zhangsan / 123456 (技术部)');
  console.log('申请人: lisi / 123456 (市场部)');
  console.log('主管: wangwu / 123456 (技术部)');
  console.log('主管: zhaoliu / 123456 (市场部)');
  console.log('财务: qianqi / 123456');
  console.log('');
  console.log('=== 部门预算 ===');
  console.log('技术部: 100,000.00');
  console.log('市场部: 80,000.00');
  console.log('财务部: 50,000.00');
});

db.close((err) => {
  if (err) console.error('关闭数据库失败:', err);
  else console.log('数据库初始化完成');
});
