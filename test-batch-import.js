const axios = require('axios');
const assert = require('assert');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const API_BASE = 'http://localhost:3000/api';
let serverProcess = null;

const users = {
  zhangsan: { username: 'zhangsan', password: '123456', role: 'applicant' },
  lisi: { username: 'lisi', password: '123456', role: 'applicant' },
  wangwu: { username: 'wangwu', password: '123456', role: 'supervisor' },
  zhaoliu: { username: 'zhaoliu', password: '123456', role: 'supervisor' },
  qianqi: { username: 'qianqi', password: '123456', role: 'finance' }
};

const tokens = {};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function login(username, password) {
  const res = await axios.post(`${API_BASE}/auth/login`, { username, password });
  return res.data.token;
}

async function apiRequest(method, url, token, data = null, maxRetries = 5) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await axios({ method, url: `${API_BASE}${url}`, data, headers, timeout: 10000 });
      return { success: true, status: res.status, data: res.data, error: null };
    } catch (err) {
      const errCode = err.code || '';
      const errMsg = err.message || '';
      const errStatus = err.response?.status || 0;
      
      if (attempt === maxRetries - 1) {
        const responseData = err.response?.data || {};
        const errorMsg = responseData.error || errMsg || errCode || 'Unknown error';
        return { success: false, status: errStatus || 500, data: responseData, error: errorMsg };
      }
      
      if (errCode === 'ECONNRESET' || 
          errCode === 'ECONNREFUSED' ||
          errCode === 'ECONNABORTED' ||
          errCode === 'ETIMEDOUT' ||
          errMsg.includes('socket hang up') ||
          errMsg.includes('timeout') ||
          errMsg.includes('connection') ||
          errStatus >= 500) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      
      const responseData = err.response?.data || {};
      const errorMsg = responseData.error || errMsg || 'Unknown error';
      return { success: false, status: errStatus || 500, data: responseData, error: errorMsg };
    }
  }
}

function logTest(name, passed, message = '') {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} - ${name}`);
  if (message) {
    console.log(`  ${message}`);
  }
  return passed;
}

async function killPort(port) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `netstat -ano | findstr :${port}`
      : `lsof -i :${port} | grep LISTEN`;
    
    exec(cmd, (err, stdout) => {
      if (err || !stdout) {
        resolve();
        return;
      }
      const lines = stdout.trim().split('\n');
      const pids = [];
      for (const line of lines) {
        const match = line.match(/\s+(\d+)\s*$/);
        if (match) {
          const pid = parseInt(match[1]);
          if (pid && pid > 0 && !pids.includes(pid)) {
            pids.push(pid);
          }
        }
      }
      if (pids.length > 0) {
        const killCmd = process.platform === 'win32'
          ? `taskkill /F ${pids.map(p => `/PID ${p}`).join(' ')}`
          : `kill -9 ${pids.join(' ')}`;
        exec(killCmd, () => {
          setTimeout(resolve, 500);
        });
      } else {
        resolve();
      }
    });
  });
}

async function startServer() {
  await killPort(3000);
  
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['server.js'], {
      cwd: __dirname,
      stdio: 'ignore'
    });

    serverProcess.on('error', reject);

    let resolved = false;
    const checkServer = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          await axios.get(`${API_BASE}/health`);
          resolved = true;
          resolve();
          return;
        } catch (e) {
          await sleep(500);
        }
      }
      if (!resolved) {
        reject(new Error('Server failed to start within 30 seconds'));
      }
    };
    checkServer();
  });
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    await sleep(1000);
    serverProcess = null;
  }
}

async function initDatabase() {
  return new Promise((resolve, reject) => {
    exec('node scripts/init-db.js', { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) {
        console.error('Init DB error:', stderr);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  console.log('\n========================================');
  console.log('  预算调整批量导入功能验证测试');
  console.log('========================================\n');

  console.log('1. 初始化数据库...');
  await initDatabase();
  console.log('   ✓ 数据库初始化完成\n');

  console.log('2. 启动服务...');
  await startServer();
  console.log('   ✓ 服务启动完成\n');

  console.log('3. 登录所有测试账号...');
  for (const [key, user] of Object.entries(users)) {
    tokens[key] = await login(user.username, user.password);
  }
  console.log('   ✓ 所有账号登录完成\n');

  console.log('========================================');
  console.log('  测试场景 1: 权限拒绝测试');
  console.log('========================================\n');

  let res = await apiRequest('POST', '/budget-batches/precheck', tokens.zhangsan, {
    batchId: 'TEST-BATCH-001',
    csvText: '部门,类型,金额,原因\n技术部,追加,50000,测试权限'
  });
  if (logTest('申请人(zhangsan)调用预检接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', '/budget-batches/precheck', tokens.wangwu, {
    batchId: 'TEST-BATCH-001',
    csvText: '部门,类型,金额,原因\n技术部,追加,50000,测试权限'
  });
  if (logTest('主管(wangwu)调用预检接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', '/budget-batches/submit', tokens.zhangsan, {
    batchId: 'TEST-BATCH-001',
    rows: [{ lineNumber: 1, department: '技术部', type: '追加', amount: '50000', reason: '测试权限' }]
  });
  if (logTest('申请人(zhangsan)调用提交接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', '/budget-batches/submit', tokens.wangwu, {
    batchId: 'TEST-BATCH-001',
    rows: [{ lineNumber: 1, department: '技术部', type: '追加', amount: '50000', reason: '测试权限' }]
  });
  if (logTest('主管(wangwu)调用提交接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 2: 预检失败测试');
  console.log('========================================\n');

  const invalidCsv = `部门,类型,金额,原因
不存在的部门,追加,50000,部门不存在测试
技术部,无效类型,30000,类型错误测试
技术部,追加,-1000,金额负数测试
技术部,追加,0,金额为零测试
技术部,追加,50000,
技术部,调减,999999,调减过度测试
市场部,调减,10000,有效行`;

  res = await apiRequest('POST', '/budget-batches/precheck', tokens.qianqi, {
    batchId: 'PRECHECK-FAIL-001',
    csvText: invalidCsv
  });

  if (logTest('预检接口返回正确的校验结果',
      res.status === 200 &&
      res.data.totalRows === 7 &&
      res.data.validRows === 1 &&
      res.data.invalidRows === 6 &&
      res.data.allValid === false)) {
    passed++;
    console.log(`  总行数: ${res.data.totalRows}, 通过: ${res.data.validRows}, 失败: ${res.data.invalidRows}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 总行数: ${res.data.totalRows}, validRows: ${res.data.validRows}`);
  }

  const results = res.data.results;
  const deptNotExist = results.find(r => r.lineNumber === 1);
  if (logTest('第1行: 不存在的部门被正确识别',
      deptNotExist?.valid === false &&
      deptNotExist?.error?.includes('部门不存在'))) {
    passed++;
  } else {
    failed++;
    console.log(`  错误: ${deptNotExist?.error}`);
  }

  const invalidType = results.find(r => r.lineNumber === 2);
  if (logTest('第2行: 无效类型被正确识别',
      invalidType?.valid === false &&
      invalidType?.error?.includes('无效的调整类型'))) {
    passed++;
  } else {
    failed++;
    console.log(`  错误: ${invalidType?.error}`);
  }

  const negativeAmount = results.find(r => r.lineNumber === 3);
  if (logTest('第3行: 负数金额被正确识别',
      negativeAmount?.valid === false &&
      negativeAmount?.error?.includes('金额必须为正数'))) {
    passed++;
  } else {
    failed++;
    console.log(`  错误: ${negativeAmount?.error}`);
  }

  const zeroAmount = results.find(r => r.lineNumber === 4);
  if (logTest('第4行: 零金额被正确识别',
      zeroAmount?.valid === false &&
      zeroAmount?.error?.includes('金额必须为正数'))) {
    passed++;
  } else {
    failed++;
    console.log(`  错误: ${zeroAmount?.error}`);
  }

  const emptyReason = results.find(r => r.lineNumber === 5);
  if (logTest('第5行: 空原因被正确识别',
      emptyReason?.valid === false &&
      emptyReason?.error?.includes('原因不能为空'))) {
    passed++;
  } else {
    failed++;
    console.log(`  错误: ${emptyReason?.error}`);
  }

  const tooMuchDecrease = results.find(r => r.lineNumber === 6);
  if (logTest('第6行: 调减过度被正确识别',
      tooMuchDecrease?.valid === false &&
      tooMuchDecrease?.error?.includes('低于已使用'))) {
    passed++;
  } else {
    failed++;
    console.log(`  错误: ${tooMuchDecrease?.error}`);
  }

  const validRow = results.find(r => r.lineNumber === 7);
  if (logTest('第7行: 有效行通过校验并显示预计调整后余额',
      validRow?.valid === true &&
      validRow?.expectedBudgetAfter !== null &&
      validRow?.currentBudget !== null)) {
    passed++;
    console.log(`  当前预算: ${validRow?.currentBudget}, 预计调整后: ${validRow?.expectedBudgetAfter}`);
  } else {
    failed++;
    console.log(`  valid: ${validRow?.valid}, currentBudget: ${validRow?.currentBudget}, expected: ${validRow?.expectedBudgetAfter}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 3: 预检失败后提交被拒绝');
  console.log('========================================\n');

  const invalidRows = [
    { lineNumber: 1, department: '不存在的部门', type: '追加', amount: '50000', reason: '测试' },
    { lineNumber: 2, department: '技术部', type: '追加', amount: '30000', reason: '有效行' }
  ];

  const deptBeforeSubmit = await apiRequest('GET', '/departments', tokens.qianqi);
  const techBudgetBefore = deptBeforeSubmit.data.departments.find(d => d.id === 1).budget_total;

  res = await apiRequest('POST', '/budget-batches/submit', tokens.qianqi, {
    batchId: 'SUBMIT-FAIL-001',
    rows: invalidRows
  });

  if (logTest('存在校验错误时提交被整批拒绝',
      res.status === 400 &&
      res.data.error?.includes('预检不通过') &&
      res.data.error?.includes('整批拒绝'))) {
    passed++;
    console.log(`  错误信息: ${res.data.error}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const deptAfterSubmit = await apiRequest('GET', '/departments', tokens.qianqi);
  const techBudgetAfter = deptAfterSubmit.data.departments.find(d => d.id === 1).budget_total;

  if (logTest('预检失败后部门预算未变化',
      Math.abs(techBudgetAfter - techBudgetBefore) < 0.01)) {
    passed++;
    console.log(`  提交前: ${techBudgetBefore}, 提交后: ${techBudgetAfter}`);
  } else {
    failed++;
    console.log(`  提交前: ${techBudgetBefore}, 提交后: ${techBudgetAfter}`);
  }

  res = await apiRequest('GET', '/budget-batches/SUBMIT-FAIL-001', tokens.qianqi);
  if (logTest('失败批次已记录到数据库',
      res.status === 200 &&
      res.data.batch.status === 'failed' &&
      res.data.batch.error_message?.includes('预检不通过'))) {
    passed++;
    console.log(`  批次状态: ${res.data.batch.status}, 错误: ${res.data.batch.error_message}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 批次状态: ${res.data.batch?.status}`);
  }

  if (logTest('失败批次明细已记录',
      res.data.lines.length === 2 &&
      res.data.lines[0].status === 'invalid' &&
      res.data.lines[1].status === 'invalid')) {
    passed++;
    console.log(`  第1行状态: ${res.data.lines[0].status}, 错误: ${res.data.lines[0].validation_error}`);
    console.log(`  第2行状态: ${res.data.lines[1].status}`);
  } else {
    failed++;
    console.log(`  行数: ${res.data.lines?.length}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 4: 成功提交批量调整');
  console.log('========================================\n');

  const deptBeforeSuccess = await apiRequest('GET', '/departments', tokens.qianqi);
  const techBeforeSuccess = deptBeforeSuccess.data.departments.find(d => d.id === 1);
  const marketBeforeSuccess = deptBeforeSuccess.data.departments.find(d => d.id === 2);
  console.log(`  提交前 - 技术部: ${techBeforeSuccess.budget_total}, 市场部: ${marketBeforeSuccess.budget_total}`);

  const validRowsForSubmit = [
    { lineNumber: 1, department: '技术部', type: '追加', amount: '50000', reason: 'Q2 设备采购预算追加' },
    { lineNumber: 2, department: '技术部', type: '追加', amount: '20000', reason: '培训预算追加' },
    { lineNumber: 3, department: '市场部', type: '调减', amount: '10000', reason: '活动预算结余回收' },
    { lineNumber: 4, department: '财务部', type: '追加', amount: '15000', reason: '审计费用预算追加' }
  ];

  res = await apiRequest('POST', '/budget-batches/submit', tokens.qianqi, {
    batchId: 'SUCCESS-BATCH-001',
    rows: validRowsForSubmit
  });

  if (logTest('有效批次提交成功',
      res.status === 200 &&
      res.data.success === true &&
      res.data.batch.status === 'completed')) {
    passed++;
    console.log(`  批次状态: ${res.data.batch.status}`);
    console.log(`  批次号: ${res.data.batch.batch_id}`);
    console.log(`  操作人: ${res.data.batch.user_name}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const deptAfterSuccess = await apiRequest('GET', '/departments', tokens.qianqi);
  const techAfterSuccess = deptAfterSuccess.data.departments.find(d => d.id === 1);
  const marketAfterSuccess = deptAfterSuccess.data.departments.find(d => d.id === 2);
  const financeAfterSuccess = deptAfterSuccess.data.departments.find(d => d.id === 3);

  const expectedTech = techBeforeSuccess.budget_total + 50000 + 20000;
  const expectedMarket = marketBeforeSuccess.budget_total - 10000;
  const expectedFinance = 50000 + 15000;

  if (logTest('技术部预算正确累计调整',
      Math.abs(techAfterSuccess.budget_total - expectedTech) < 0.01)) {
    passed++;
    console.log(`  技术部: 调整前 ${techBeforeSuccess.budget_total} → 调整后 ${techAfterSuccess.budget_total} (预期 ${expectedTech})`);
  } else {
    failed++;
    console.log(`  技术部: 实际 ${techAfterSuccess.budget_total}, 预期 ${expectedTech}`);
  }

  if (logTest('市场部预算正确调减',
      Math.abs(marketAfterSuccess.budget_total - expectedMarket) < 0.01)) {
    passed++;
    console.log(`  市场部: 调整前 ${marketBeforeSuccess.budget_total} → 调整后 ${marketAfterSuccess.budget_total} (预期 ${expectedMarket})`);
  } else {
    failed++;
    console.log(`  市场部: 实际 ${marketAfterSuccess.budget_total}, 预期 ${expectedMarket}`);
  }

  if (logTest('财务部预算正确追加',
      Math.abs(financeAfterSuccess.budget_total - expectedFinance) < 0.01)) {
    passed++;
    console.log(`  财务部: 调整前 50000 → 调整后 ${financeAfterSuccess.budget_total} (预期 ${expectedFinance})`);
  } else {
    failed++;
    console.log(`  财务部: 实际 ${financeAfterSuccess.budget_total}, 预期 ${expectedFinance}`);
  }

  res = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  const batchAdjustments = res.data.adjustments.filter(a => a.batch_id === 'SUCCESS-BATCH-001');
  if (logTest('所有调整记录都带有 batch_id 和 batch_line',
      batchAdjustments.length === 4 &&
      batchAdjustments.every(a => a.batch_line !== null))) {
    passed++;
    console.log(`  批量调整记录数: ${batchAdjustments.length}`);
    batchAdjustments.forEach(a => {
      console.log(`    #${a.id}: 行号 ${a.batch_line}, ${a.adjustment_type} ¥${a.amount}`);
    });
  } else {
    failed++;
    console.log(`  批量调整记录数: ${batchAdjustments.length}`);
  }

  res = await apiRequest('GET', '/budget-batches/SUCCESS-BATCH-001', tokens.qianqi);
  if (logTest('批次详情正确记录所有行',
      res.status === 200 &&
      res.data.lines.length === 4 &&
      res.data.lines.every(l => l.status === 'submitted' && l.adjustment_id))) {
    passed++;
    console.log(`  批次总行数: ${res.data.lines.length}`);
    res.data.lines.forEach(l => {
      console.log(`    行${l.line_number}: ${l.department_name} ${l.adjustment_type} ¥${l.amount} → 调整记录 #${l.adjustment_id}`);
    });
  } else {
    failed++;
    console.log(`  行数: ${res.data.lines?.length}`);
  }

  res = await apiRequest('GET', '/budget-batches', tokens.qianqi);
  if (logTest('批次列表包含所有批次',
      res.status === 200 &&
      res.data.batches.length >= 2)) {
    passed++;
    console.log(`  批次总数: ${res.data.batches.length}`);
    res.data.batches.forEach(b => {
      console.log(`    ${b.batch_id}: ${b.status}, ${b.total_rows}行, 操作人 ${b.user_name}`);
    });
  } else {
    failed++;
    console.log(`  批次总数: ${res.data.batches?.length}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 5: 重复批次幂等性测试');
  console.log('========================================\n');

  const deptBeforeDuplicate = await apiRequest('GET', '/departments', tokens.qianqi);
  const techBeforeDup = deptBeforeDuplicate.data.departments.find(d => d.id === 1).budget_total;

  res = await apiRequest('POST', '/budget-batches/submit', tokens.qianqi, {
    batchId: 'SUCCESS-BATCH-001',
    rows: validRowsForSubmit
  });

  if (logTest('重复批次号提交被拒绝',
      res.status === 409 &&
      res.data.error?.includes('已存在') &&
      res.data.error?.includes('不能重复提交'))) {
    passed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const deptAfterDuplicate = await apiRequest('GET', '/departments', tokens.qianqi);
  const techAfterDup = deptAfterDuplicate.data.departments.find(d => d.id === 1).budget_total;

  if (logTest('重复提交后预算未变化',
      Math.abs(techAfterDup - techBeforeDup) < 0.01)) {
    passed++;
    console.log(`  提交前: ${techBeforeDup}, 提交后: ${techAfterDup}`);
  } else {
    failed++;
    console.log(`  提交前: ${techBeforeDup}, 提交后: ${techAfterDup}`);
  }

  res = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  const adjustCountAfter = res.data.adjustments.filter(a => a.batch_id === 'SUCCESS-BATCH-001').length;
  if (logTest('重复提交后调整记录数未增加',
      adjustCountAfter === 4)) {
    passed++;
    console.log(`  批量调整记录数: ${adjustCountAfter}`);
  } else {
    failed++;
    console.log(`  批量调整记录数: ${adjustCountAfter} (预期 4)`);
  }

  console.log('\n========================================');
  console.log('  测试场景 6: 同部门累计调减冲突测试');
  console.log('========================================\n');

  const appPayload = {
    amount: 120000,
    supplier: '测试供应商',
    purpose: '测试预算锁定导致批量调减冲突'
  };
  const appRes = await apiRequest('POST', '/applications', tokens.zhangsan, appPayload);
  const appId = appRes.data.application.id;
  console.log(`  创建申请 #${appId}，金额 120000`);

  await apiRequest('POST', `/applications/${appId}/approve`, tokens.wangwu, { remark: '通过' });
  console.log(`  申请 #${appId} 已审批通过，预算锁定 120000\n`);

  const conflictRows = [
    { lineNumber: 1, department: '技术部', type: '调减', amount: '30000', reason: '第一笔调减' },
    { lineNumber: 2, department: '技术部', type: '调减', amount: '30000', reason: '第二笔调减导致低于锁定' }
  ];

  const techBeforeConflict = await apiRequest('GET', '/departments', tokens.qianqi);
  const techBudgetBeforeConflict = techBeforeConflict.data.departments.find(d => d.id === 1).budget_total;
  const techLocked = techBeforeConflict.data.departments.find(d => d.id === 1).budget_locked;
  const techUsed = techBeforeConflict.data.departments.find(d => d.id === 1).budget_used;
  console.log(`  技术部当前预算: ${techBudgetBeforeConflict}`);
  console.log(`  已使用: ${techUsed}, 锁定中: ${techLocked}`);
  console.log(`  最低允许: ${techUsed + techLocked}\n`);

  res = await apiRequest('POST', '/budget-batches/submit', tokens.qianqi, {
    batchId: 'CONFLICT-BATCH-001',
    rows: conflictRows
  });

  if (logTest('累计调减导致低于锁定时整批拒绝',
      res.status === 400 &&
      res.data.error?.includes('累计调减后预算') &&
      res.data.error?.includes('低于已使用加锁定金额'))) {
    passed++;
    console.log(`  错误信息: ${res.data.error}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const techAfterConflict = await apiRequest('GET', '/departments', tokens.qianqi);
  const techBudgetAfterConflict = techAfterConflict.data.departments.find(d => d.id === 1).budget_total;

  if (logTest('冲突失败后部门预算未变化',
      Math.abs(techBudgetAfterConflict - techBudgetBeforeConflict) < 0.01)) {
    passed++;
    console.log(`  提交前: ${techBudgetBeforeConflict}, 提交后: ${techBudgetAfterConflict}`);
  } else {
    failed++;
    console.log(`  提交前: ${techBudgetBeforeConflict}, 提交后: ${techBudgetAfterConflict}`);
  }

  res = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  const conflictAdjustments = res.data.adjustments.filter(a => a.batch_id === 'CONFLICT-BATCH-001');
  if (logTest('冲突失败后没有生成调整记录',
      conflictAdjustments.length === 0)) {
    passed++;
  } else {
    failed++;
    console.log(`  意外生成了 ${conflictAdjustments.length} 条调整记录`);
  }

  console.log('\n========================================');
  console.log('  测试场景 7: 一致性检查验证');
  console.log('========================================\n');

  res = await apiRequest('GET', '/ledger/check', tokens.qianqi);
  if (logTest('批量调整后一致性检查仍通过',
      res.status === 200 &&
      res.data.overallConsistent === true &&
      res.data.inconsistencies.length === 0)) {
    passed++;
    console.log(`  一致性检查: 通过`);
  } else {
    failed++;
    console.log(`  一致: ${res.data.overallConsistent}, 不一致项: ${res.data.inconsistencies?.length || 0}`);
    if (res.data.inconsistencies?.length > 0) {
      res.data.inconsistencies.forEach(i => console.log(`  - ${i.message}`));
    }
  }

  const adjustmentsWithBatch = res.data.budgetAdjustments.filter(a => a.batch_id);
  if (logTest('一致性检查结果包含 batch_id 信息',
      adjustmentsWithBatch.length >= 4 &&
      adjustmentsWithBatch.every(a => a.batch_line !== null))) {
    passed++;
    console.log(`  带 batch_id 的调整记录: ${adjustmentsWithBatch.length} 条`);
  } else {
    failed++;
    console.log(`  带 batch_id 的调整记录: ${adjustmentsWithBatch.length} 条`);
  }

  console.log('\n========================================');
  console.log('  测试场景 8: CSV 导出包含批次信息');
  console.log('========================================\n');

  try {
    const exportRes = await axios({
      method: 'GET',
      url: `${API_BASE}/ledger/export`,
      headers: { Authorization: `Bearer ${tokens.qianqi}` },
      responseType: 'text'
    });

    const csvContent = exportRes.data;
    const lines = csvContent.split('\n');
    const header = lines[0];

    if (logTest('账本导出 CSV 包含批次信息列',
        header.includes('批次号') &&
        header.includes('批次行号') &&
        header.includes('批次信息'))) {
      passed++;
      console.log('  ✓ 包含批次号、批次行号、批次信息列');
    } else {
      failed++;
      console.log(`  表头: ${header}`);
    }

    const batchLines = lines.filter(l => l.includes('SUCCESS-BATCH-001'));
    if (logTest('账本导出包含批量调整记录',
        batchLines.length >= 4)) {
      passed++;
      console.log(`  批量调整记录: ${batchLines.length} 条`);
    } else {
      failed++;
      console.log(`  批量调整记录: ${batchLines.length} 条 (预期 >=4)`);
    }

    fs.writeFileSync(path.join(__dirname, 'exports', 'test-batch-ledger-export.csv'), csvContent);
    console.log(`  ✓ 测试导出文件已保存: exports/test-batch-ledger-export.csv`);
  } catch (err) {
    failed += 2;
    console.log(`  导出失败: ${err.message}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 9: 批次 CSV 导出');
  console.log('========================================\n');

  try {
    const batchExportRes = await axios({
      method: 'GET',
      url: `${API_BASE}/budget-batches/SUCCESS-BATCH-001/export`,
      headers: { Authorization: `Bearer ${tokens.qianqi}` },
      responseType: 'text'
    });

    const csvContent = batchExportRes.data;
    const lines = csvContent.split('\n').filter(line => line.trim() !== '');
    const header = lines[0];

    if (logTest('批次导出 CSV 格式正确',
        header.includes('批次号') &&
        header.includes('行号') &&
        header.includes('部门') &&
        header.includes('调整类型') &&
        header.includes('金额') &&
        header.includes('调整前预算') &&
        header.includes('调整后预算') &&
        header.includes('原因'))) {
      passed++;
      console.log('  ✓ 包含所有必要列');
    } else {
      failed++;
      console.log(`  表头: ${header}`);
    }

    if (logTest('批次导出包含 4 条数据行',
        lines.length === 5)) {
      passed++;
      console.log(`  数据行数: ${lines.length - 1}`);
    } else {
      failed++;
      console.log(`  数据行数: ${lines.length - 1} (预期 4)`);
    }

    fs.writeFileSync(path.join(__dirname, 'exports', 'test-batch-export.csv'), csvContent);
    console.log(`  ✓ 测试批次导出已保存: exports/test-batch-export.csv`);
  } catch (err) {
    failed += 2;
    console.log(`  导出失败: ${err.message}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 10: 服务重启后数据持久化');
  console.log('========================================\n');

  const stateBeforeRestart = {};
  const batchState = await apiRequest('GET', '/budget-batches', tokens.qianqi);
  stateBeforeRestart.batches = batchState.data.batches;
  const deptState = await apiRequest('GET', '/departments', tokens.qianqi);
  stateBeforeRestart.departments = deptState.data.departments;

  const successBatchBefore = stateBeforeRestart.batches.find(b => b.batch_id === 'SUCCESS-BATCH-001');
  const techBeforeRestart = stateBeforeRestart.departments.find(d => d.id === 1);
  console.log(`  重启前: 批次 SUCCESS-BATCH-001 状态 ${successBatchBefore.status}`);
  console.log(`  重启前: 技术部总预算 ${techBeforeRestart.budget_total.toFixed(2)}\n`);

  console.log('  重启服务中...');
  await stopServer();
  await sleep(2000);
  await startServer();
  console.log('  ✓ 服务已重启\n');

  tokens.qianqi = await login('qianqi', '123456');

  const batchAfterRestart = await apiRequest('GET', '/budget-batches/SUCCESS-BATCH-001', tokens.qianqi);
  if (batchAfterRestart.success && batchAfterRestart.data.batch) {
    if (logTest('重启后批次状态保持一致',
        batchAfterRestart.data.batch.status === 'completed' &&
        batchAfterRestart.data.lines.length === 4)) {
      passed++;
      console.log(`  批次状态: ${batchAfterRestart.data.batch.status}, 行数: ${batchAfterRestart.data.lines.length}`);
    } else {
      failed++;
      console.log(`  批次状态: ${batchAfterRestart.data.batch?.status}`);
    }

    if (logTest('重启后批次明细完整',
        batchAfterRestart.data.lines.every(l => l.adjustment_id && l.budget_before && l.budget_after))) {
      passed++;
      const sampleLine = batchAfterRestart.data.lines[0];
      console.log(`  第1行: ${sampleLine.department_name} ${sampleLine.adjustment_type} ¥${sampleLine.amount}, 调整记录 #${sampleLine.adjustment_id}`);
    } else {
      failed++;
      console.log(`  批次明细不完整`);
    }
  } else {
    failed += 2;
    console.log(`  获取重启后批次数据失败: ${batchAfterRestart.error}`);
  }

  const deptAfterRestart = await apiRequest('GET', '/departments', tokens.qianqi);
  if (deptAfterRestart.success && deptAfterRestart.data.departments) {
    const techAfterRestart = deptAfterRestart.data.departments.find(d => d.id === 1);
    if (logTest('重启后部门预算数据保持一致',
        Math.abs(techAfterRestart.budget_total - techBeforeRestart.budget_total) < 0.01)) {
      passed++;
      console.log(`  技术部总预算: ${techAfterRestart.budget_total.toFixed(2)}`);
    } else {
      failed++;
      console.log(`  重启前: ${techBeforeRestart.budget_total}, 重启后: ${techAfterRestart.budget_total}`);
    }
  } else {
    failed++;
    console.log(`  获取重启后部门数据失败: ${deptAfterRestart.error}`);
  }

  const adjAfterRestart = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  if (adjAfterRestart.success && adjAfterRestart.data.adjustments) {
    const batchAdjAfter = adjAfterRestart.data.adjustments.filter(a => a.batch_id === 'SUCCESS-BATCH-001');
    if (logTest('重启后批量调整记录完整',
        batchAdjAfter.length === 4 &&
        batchAdjAfter.every(a => a.batch_line !== null))) {
      passed++;
      console.log(`  批量调整记录: ${batchAdjAfter.length} 条`);
    } else {
      failed++;
      console.log(`  批量调整记录: ${batchAdjAfter.length} 条`);
    }
  } else {
    failed++;
    console.log(`  获取重启后调整记录失败: ${adjAfterRestart.error}`);
  }

  const checkAfterRestart = await apiRequest('GET', '/ledger/check', tokens.qianqi);
  if (logTest('重启后一致性检查仍通过',
      checkAfterRestart.data.overallConsistent === true)) {
    passed++;
    console.log(`  一致性检查: 通过`);
  } else {
    failed++;
    console.log(`  不一致项: ${checkAfterRestart.data.inconsistencies?.length || 0}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 11: 批量调整历史可查询');
  console.log('========================================\n');

  res = await apiRequest('GET', '/budget-adjustments', tokens.zhangsan);
  if (logTest('申请人可查看批量调整历史',
      res.status === 200 &&
      res.data.adjustments.some(a => a.batch_id === 'SUCCESS-BATCH-001'))) {
    passed++;
    const batchAdj = res.data.adjustments.find(a => a.batch_id === 'SUCCESS-BATCH-001');
    console.log(`  申请人可看到批量调整记录 #${batchAdj.id}, 批次: ${batchAdj.batch_id}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 是否有批量记录: ${res.data.adjustments?.some(a => a.batch_id === 'SUCCESS-BATCH-001')}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 12: CSV 文件上传预检');
  console.log('========================================\n');

  const testCsvContent = `部门,类型,金额,原因
技术部,追加,25000,CSV测试追加1
市场部,调减,5000,CSV测试调减1
技术部,increase,15000,英文类型测试
财务部,decrease,3000,英文类型调减
技术部,+,10000,符号类型追加
市场部,-,2000,符号类型调减`;

  res = await apiRequest('POST', '/budget-batches/precheck', tokens.qianqi, {
    batchId: 'CSV-PRECHECK-001',
    csvText: testCsvContent
  });

  if (logTest('CSV 解析支持多种类型格式',
      res.status === 200 &&
      res.data.allValid === true &&
      res.data.totalRows === 6)) {
    passed++;
    console.log(`  总行数: ${res.data.totalRows}, 全部通过: ${res.data.allValid}`);
    res.data.results.forEach(r => {
      console.log(`    行${r.lineNumber}: ${r.department} ${r.adjustmentType} ¥${r.amountNum} → ${r.valid ? '✓' : '✗'}`);
    });
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  console.log('\n========================================');
  console.log('  测试结果汇总');
  console.log('========================================\n');
  console.log(`  总测试数: ${passed + failed}`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log('');

  await stopServer();

  return failed === 0;
}

runTests()
  .then((allPassed) => {
    console.log(allPassed ? '\n✓ 所有测试通过！\n' : '\n✗ 部分测试失败，请检查\n');
    process.exit(allPassed ? 0 : 1);
  })
  .catch((err) => {
    console.error('\n测试执行出错:', err);
    if (serverProcess) serverProcess.kill();
    process.exit(1);
  });
