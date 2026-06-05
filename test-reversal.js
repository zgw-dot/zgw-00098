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
  console.log('  预算调整冲正功能验证测试');
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

  let res = await apiRequest('POST', '/budget-adjustments/1/reverse', tokens.zhangsan, { reason: '测试权限' });
  if (logTest('申请人(zhangsan)调用冲正接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', '/budget-adjustments/1/reverse', tokens.wangwu, { reason: '测试权限' });
  if (logTest('主管(wangwu)调用冲正接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 2: 准备测试数据');
  console.log('========================================\n');

  const increasePayload = {
    departmentId: 1,
    adjustmentType: 'increase',
    amount: 50000,
    reason: 'Q2 技术设备采购预算追加'
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, increasePayload);
  const increaseAdjId = res.data.adjustment.id;
  if (logTest('财务追加技术部预算 50000 成功',
      res.status === 200 && res.data.adjustment.adjustment_type === 'increase')) {
    passed++;
    console.log(`  调整记录 #${increaseAdjId}，调整后预算: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const decreasePayload = {
    departmentId: 2,
    adjustmentType: 'decrease',
    amount: 20000,
    reason: 'Q2 市场活动预算结余回收'
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, decreasePayload);
  const decreaseAdjId = res.data.adjustment.id;
  if (logTest('财务调减市场部预算 20000 成功',
      res.status === 200 && res.data.adjustment.adjustment_type === 'decrease')) {
    passed++;
    console.log(`  调整记录 #${decreaseAdjId}，调整后预算: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 3: 冲正原因验证');
  console.log('========================================\n');

  res = await apiRequest('POST', `/budget-adjustments/${increaseAdjId}/reverse`, tokens.qianqi, { reason: '' });
  if (logTest('空原因被拒绝',
      res.status === 400 && res.data.error?.includes('冲正原因不能为空'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', `/budget-adjustments/${increaseAdjId}/reverse`, tokens.qianqi, { reason: '   ' });
  if (logTest('全空格原因被拒绝',
      res.status === 400 && res.data.error?.includes('冲正原因不能为空'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', `/budget-adjustments/${increaseAdjId}/reverse`, tokens.qianqi, {});
  if (logTest('未传原因字段被拒绝',
      res.status === 400 && res.data.error?.includes('冲正原因不能为空'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 4: 成功冲正 - 追加预算');
  console.log('========================================\n');

  const deptBefore = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptBefore = deptBefore.data.departments.find(d => d.id === 1);
  const budgetBeforeReverse = techDeptBefore.budget_total;
  const adjCountBefore = techDeptBefore.adjustment_count;

  console.log(`  冲正前技术部预算: ${budgetBeforeReverse.toFixed(2)}`);
  console.log(`  冲正前调整次数: ${adjCountBefore}`);

  res = await apiRequest('POST', `/budget-adjustments/${increaseAdjId}/reverse`, tokens.qianqi, {
    reason: '发现预算追加录错，金额应该是 30000 而非 50000'
  });

  if (logTest('冲正追加预算成功',
      res.status === 200 &&
      res.data.reversalAdjustment.adjustment_type === 'reversal' &&
      res.data.reversalAdjustment.reversal_of_id === increaseAdjId &&
      res.data.originalAdjustment.is_reversed === 1)) {
    passed++;
    console.log(`  冲正记录 #${res.data.reversalAdjustment.id}`);
    console.log(`  冲正后原记录状态: 已冲正`);
    console.log(`  冲正人: ${res.data.reversalAdjustment.user_name}`);
    console.log(`  冲正原因: ${res.data.reversalAdjustment.reason}`);
    console.log(`  冲正后预算: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const expectedAfterReverse = budgetBeforeReverse - 50000;
  if (logTest('冲正后预算正确回滚',
      Math.abs(res.data.department.budget_total - expectedAfterReverse) < 0.01 &&
      Math.abs(res.data.department.budget_total - 100000) < 0.01)) {
    passed++;
    console.log(`  预期: ${expectedAfterReverse.toFixed(2)}, 实际: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  预期: ${expectedAfterReverse.toFixed(2)}, 实际: ${res.data.department?.budget_total}`);
  }

  res = await apiRequest('GET', `/budget-adjustments/${increaseAdjId}`, tokens.qianqi);
  if (logTest('原调整记录显示已冲正状态',
      res.data.adjustment.is_reversed === 1 &&
      res.data.adjustment.reversed_by_name === 'qianqi' &&
      res.data.adjustment.reversal_reason === '发现预算追加录错，金额应该是 30000 而非 50000')) {
    passed++;
    console.log(`  冲正人: ${res.data.adjustment.reversed_by_name}`);
    console.log(`  冲正原因: ${res.data.adjustment.reversal_reason}`);
    console.log(`  冲正时间: ${res.data.adjustment.reversed_at}`);
  } else {
    failed++;
    console.log(`  is_reversed: ${res.data.adjustment?.is_reversed}`);
    console.log(`  reversed_by_name: ${res.data.adjustment?.reversed_by_name}`);
  }

  const reversalAdjId = res.data.adjustment.reversal_adjustment_id;
  res = await apiRequest('GET', `/budget-adjustments/${reversalAdjId}`, tokens.qianqi);
  if (logTest('冲正记录显示正确的关联关系',
      res.data.adjustment.adjustment_type === 'reversal' &&
      res.data.adjustment.reversal_of_id === increaseAdjId &&
      res.data.adjustment.original_reason === 'Q2 技术设备采购预算追加')) {
    passed++;
    console.log(`  冲正记录类型: ${res.data.adjustment.adjustment_type}`);
    console.log(`  关联原记录: #${res.data.adjustment.reversal_of_id}`);
    console.log(`  原调整原因: ${res.data.adjustment.original_reason}`);
  } else {
    failed++;
    console.log(`  adjustment_type: ${res.data.adjustment?.adjustment_type}`);
    console.log(`  reversal_of_id: ${res.data.adjustment?.reversal_of_id}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 5: 成功冲正 - 调减预算');
  console.log('========================================\n');

  const marketBefore = await apiRequest('GET', '/departments', tokens.qianqi);
  const marketDeptBefore = marketBefore.data.departments.find(d => d.id === 2);
  const marketBudgetBefore = marketDeptBefore.budget_total;

  console.log(`  冲正前市场部预算: ${marketBudgetBefore.toFixed(2)}`);

  res = await apiRequest('POST', `/budget-adjustments/${decreaseAdjId}/reverse`, tokens.qianqi, {
    reason: '发现调减预算录错，活动预算仍需保留'
  });

  if (logTest('冲正调减预算成功',
      res.status === 200 &&
      res.data.reversalAdjustment.adjustment_type === 'reversal')) {
    passed++;
    console.log(`  冲正记录 #${res.data.reversalAdjustment.id}`);
    console.log(`  冲正后预算: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const expectedMarketAfter = marketBudgetBefore + 20000;
  if (logTest('冲正调减后预算正确增加',
      Math.abs(res.data.department.budget_total - expectedMarketAfter) < 0.01 &&
      Math.abs(res.data.department.budget_total - 80000) < 0.01)) {
    passed++;
    console.log(`  预期: ${expectedMarketAfter.toFixed(2)}, 实际: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  预期: ${expectedMarketAfter.toFixed(2)}, 实际: ${res.data.department?.budget_total}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 6: 重复冲正失败');
  console.log('========================================\n');

  res = await apiRequest('POST', `/budget-adjustments/${increaseAdjId}/reverse`, tokens.qianqi, {
    reason: '尝试重复冲正'
  });

  if (logTest('已冲正记录不能重复冲正',
      res.status === 400 &&
      res.data.error?.includes('已被冲正') &&
      res.data.error?.includes('不能重复冲正'))) {
    passed++;
    console.log(`  错误信息: ${res.data.error}`);
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const deptAfterRepeat = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptAfterRepeat = deptAfterRepeat.data.departments.find(d => d.id === 1);
  if (logTest('重复冲正失败后预算未变化',
      Math.abs(techDeptAfterRepeat.budget_total - 100000) < 0.01)) {
    passed++;
    console.log(`  预算保持: ${techDeptAfterRepeat.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  实际预算: ${techDeptAfterRepeat.budget_total}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 7: 冲正冲突检测');
  console.log('========================================\n');

  const newIncreasePayload = {
    departmentId: 1,
    adjustmentType: 'increase',
    amount: 30000,
    reason: '正确的预算追加金额'
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, newIncreasePayload);
  const newIncreaseId = res.data.adjustment.id;
  console.log(`  创建新的追加调整 #${newIncreaseId}，金额 30000\n`);

  const appPayload = {
    amount: 120000,
    supplier: '测试供应商',
    purpose: '测试预算锁定导致冲正冲突'
  };
  const appRes = await apiRequest('POST', '/applications', tokens.zhangsan, appPayload);
  const appId = appRes.data.application.id;
  console.log(`  创建申请 #${appId}，金额 120000`);

  await apiRequest('POST', `/applications/${appId}/approve`, tokens.wangwu, { remark: '通过' });
  console.log(`  申请 #${appId} 已审批通过，预算锁定 120000\n`);

  const techDeptConflict = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptBeforeConflict = techDeptConflict.data.departments.find(d => d.id === 1);
  console.log(`  技术部当前预算: ${techDeptBeforeConflict.budget_total.toFixed(2)}`);
  console.log(`  已使用: ${techDeptBeforeConflict.budget_used.toFixed(2)}`);
  console.log(`  锁定中: ${techDeptBeforeConflict.budget_locked.toFixed(2)}`);
  console.log(`  最低允许: ${(techDeptBeforeConflict.budget_used + techDeptBeforeConflict.budget_locked).toFixed(2)}\n`);

  res = await apiRequest('POST', `/budget-adjustments/${newIncreaseId}/reverse`, tokens.qianqi, {
    reason: '尝试冲正但会导致预算不足'
  });

  const minAllowed = techDeptBeforeConflict.budget_used + techDeptBeforeConflict.budget_locked;
  const expectedAfterConflict = techDeptBeforeConflict.budget_total - 30000;

  if (logTest('冲正导致预算低于已使用+锁定被拒绝',
      res.status === 400 &&
      res.data.error?.includes('冲正后总预算不能低于已使用加锁定金额'))) {
    passed++;
    console.log(`  冲正后将为: ${expectedAfterConflict.toFixed(2)}`);
    console.log(`  最低允许: ${minAllowed.toFixed(2)}`);
    console.log(`  错误信息: ${res.data.error}`);
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const techDeptAfterConflict = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptAfterConflictData = techDeptAfterConflict.data.departments.find(d => d.id === 1);
  if (logTest('冲正失败后预算未变化',
      Math.abs(techDeptAfterConflictData.budget_total - techDeptBeforeConflict.budget_total) < 0.01)) {
    passed++;
    console.log(`  预算保持: ${techDeptAfterConflictData.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  冲正前: ${techDeptBeforeConflict.budget_total}, 冲正后: ${techDeptAfterConflictData.budget_total}`);
  }

  res = await apiRequest('GET', `/budget-adjustments/${newIncreaseId}`, tokens.qianqi);
  if (logTest('冲正失败后原记录状态仍为正常',
      res.data.adjustment.is_reversed === 0 || res.data.adjustment.is_reversed === false)) {
    passed++;
    console.log(`  is_reversed: ${res.data.adjustment.is_reversed}`);
  } else {
    failed++;
    console.log(`  is_reversed: ${res.data.adjustment.is_reversed}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 8: 冲正记录不能被冲正');
  console.log('========================================\n');

  res = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  const reversalRecords = res.data.adjustments.filter(a => a.adjustment_type === 'reversal');
  const firstReversalId = reversalRecords[0]?.id;

  if (firstReversalId) {
    res = await apiRequest('POST', `/budget-adjustments/${firstReversalId}/reverse`, tokens.qianqi, {
      reason: '尝试冲正冲正记录'
    });

    if (logTest('冲正记录本身不能被冲正',
        res.status === 400 &&
        res.data.error?.includes('冲正记录本身不能被冲正'))) {
      passed++;
      console.log(`  错误信息: ${res.data.error}`);
    } else {
      failed++;
      console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
    }
  } else {
    failed++;
    console.log('  未找到冲正记录进行测试');
  }

  console.log('\n========================================');
  console.log('  测试场景 9: 调整历史包含冲正记录');
  console.log('========================================\n');

  res = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  const allAdj = res.data.adjustments;
  const reversalCount = allAdj.filter(a => a.adjustment_type === 'reversal').length;
  const reversedCount = allAdj.filter(a => a.is_reversed).length;

  if (logTest('调整历史包含冲正记录',
      reversalCount >= 2 && reversedCount >= 2)) {
    passed++;
    console.log(`  总记录数: ${allAdj.length}`);
    console.log(`  冲正记录数: ${reversalCount}`);
    console.log(`  已冲正记录数: ${reversedCount}`);
  } else {
    failed++;
    console.log(`  总记录数: ${allAdj.length}`);
    console.log(`  冲正记录数: ${reversalCount} (预期 >=2)`);
    console.log(`  已冲正记录数: ${reversedCount} (预期 >=2)`);
  }

  const deptStats = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptStats = deptStats.data.departments.find(d => d.id === 1);
  if (logTest('部门调整统计包含冲正信息',
      techDeptStats.adjustment_count >= 3 &&
      techDeptStats.adjustment_stats &&
      techDeptStats.adjustment_stats.reversed >= 1)) {
    passed++;
    console.log(`  技术部总调整次数: ${techDeptStats.adjustment_count}`);
    console.log(`  已冲正次数: ${techDeptStats.adjustment_stats.reversed}`);
    console.log(`  冲正记录次数: ${techDeptStats.adjustment_stats.reversal}`);
    console.log(`  有效调整次数: ${techDeptStats.adjustment_stats.effective}`);
  } else {
    failed++;
    console.log(`  adjustment_count: ${techDeptStats.adjustment_count}`);
    console.log(`  adjustment_stats: ${JSON.stringify(techDeptStats.adjustment_stats)}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 10: 一致性检查验证');
  console.log('========================================\n');

  res = await apiRequest('GET', '/ledger/check', tokens.qianqi);
  if (logTest('冲正后一致性检查仍通过',
      res.status === 200 &&
      res.data.overallConsistent === true &&
      res.data.inconsistencies.length === 0)) {
    passed++;
    console.log(`  一致性检查: 通过`);
    console.log(`  总调整记录数: ${res.data.summary.budget_adjustment_count}`);
    console.log(`  已冲正记录数: ${res.data.summary.total_reversed_count}`);
    console.log(`  累计追加: ${res.data.summary.total_adjustments_increase.toFixed(2)}`);
    console.log(`  累计调减: ${res.data.summary.total_adjustments_decrease.toFixed(2)}`);
    console.log(`  累计冲正: ${res.data.summary.total_adjustments_reversal.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  一致: ${res.data.overallConsistent}`);
    console.log(`  不一致项: ${res.data.inconsistencies?.length || 0}`);
    if (res.data.inconsistencies?.length > 0) {
      res.data.inconsistencies.forEach(i => console.log(`  - ${i.message}`));
    }
  }

  if (res.data.budgetAdjustments && res.data.budgetAdjustments.length > 0) {
    const allAdjConsistent = res.data.budgetAdjustments.every(a => a.amount_consistent === true);
    if (logTest('所有调整记录(含冲正)金额计算一致', allAdjConsistent)) {
      passed++;
    } else {
      failed++;
      const bad = res.data.budgetAdjustments.filter(a => !a.amount_consistent);
      bad.forEach(a => console.log(`  - 调整 #${a.id} 不一致`));
    }

    const hasReversalInfo = res.data.budgetAdjustments.some(a => a.adjustment_type === 'reversal');
    if (logTest('一致性检查结果包含冲正记录信息', hasReversalInfo)) {
      passed++;
    } else {
      failed++;
      console.log('  未找到冲正记录信息');
    }

    const hasReversedStatus = res.data.budgetAdjustments.some(a => a.is_reversed === true);
    if (logTest('一致性检查结果包含已冲正状态', hasReversedStatus)) {
      passed++;
    } else {
      failed++;
      console.log('  未找到已冲正状态记录');
    }
  }

  console.log('\n========================================');
  console.log('  测试场景 11: CSV 导出包含冲正关系');
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

    if (logTest('CSV 导出包含冲正关系列',
        header.includes('冲正关系') &&
        header.includes('冲正人') &&
        header.includes('冲正时间') &&
        header.includes('冲正原因'))) {
      passed++;
      console.log('  ✓ 包含冲正关系、冲正人、冲正时间、冲正原因列');
    } else {
      failed++;
      console.log(`  表头: ${header}`);
    }

    const reversalRecords = lines.filter(l => l.includes('冲正调整'));
    const reversedRecords = lines.filter(l => l.includes('已冲正'));

    if (logTest('CSV 包含冲正记录和已冲正记录',
        reversalRecords.length >= 2 && reversedRecords.length >= 2)) {
      passed++;
      console.log(`  冲正记录: ${reversalRecords.length} 条`);
      console.log(`  已冲正记录: ${reversedRecords.length} 条`);
    } else {
      failed++;
      console.log(`  冲正记录: ${reversalRecords.length} 条 (预期 >=2)`);
      console.log(`  已冲正记录: ${reversedRecords.length} 条 (预期 >=2)`);
    }

    const hasReversalRelation = lines.some(l => l.includes('冲正记录 #'));
    if (logTest('CSV 包含冲正关联关系说明', hasReversalRelation)) {
      passed++;
      const sample = lines.find(l => l.includes('冲正记录 #'));
      if (sample) {
        const cols = sample.split(',');
        console.log(`  冲正关系示例: ${cols[12]?.trim() || cols[11]?.trim()}`);
      }
    } else {
      failed++;
      console.log('  未找到冲正关联关系说明');
    }

    fs.writeFileSync(path.join(__dirname, 'exports', 'test-reversal-export.csv'), csvContent);
    console.log(`  ✓ 测试导出文件已保存: exports/test-reversal-export.csv`);
  } catch (err) {
    failed += 4;
    console.log(`  导出失败: ${err.message}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 12: 服务重启后数据持久化');
  console.log('========================================\n');

  const stateBeforeRestart = {};
  const deptState = await apiRequest('GET', '/departments', tokens.qianqi);
  stateBeforeRestart.departments = deptState.data.departments;
  const adjState = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  stateBeforeRestart.adjustments = adjState.data.adjustments;
  const checkState = await apiRequest('GET', '/ledger/check', tokens.qianqi);
  stateBeforeRestart.check = checkState.data;

  const techBefore = stateBeforeRestart.departments.find(d => d.id === 1);
  const reversedBefore = stateBeforeRestart.adjustments.filter(a => a.is_reversed).length;
  console.log(`  重启前: 技术部总预算 ${techBefore.budget_total.toFixed(2)}`);
  console.log(`  重启前: 已冲正记录 ${reversedBefore} 条`);
  console.log(`  重启前: 一致性检查 ${stateBeforeRestart.check.overallConsistent ? '通过' : '失败'}\n`);

  console.log('  重启服务中...');
  await stopServer();
  await sleep(2000);
  await startServer();
  console.log('  ✓ 服务已重启\n');

  tokens.qianqi = await login('qianqi', '123456');

  const deptAfterRestart = await apiRequest('GET', '/departments', tokens.qianqi);
  if (deptAfterRestart.success && deptAfterRestart.data.departments) {
    const techAfter = deptAfterRestart.data.departments.find(d => d.id === 1);
    if (logTest('重启后部门预算数据保持一致',
        Math.abs(techAfter.budget_total - techBefore.budget_total) < 0.01)) {
      passed++;
      console.log(`  技术部总预算: ${techAfter.budget_total.toFixed(2)}`);
    } else {
      failed++;
      console.log(`  重启前: ${techBefore.budget_total}, 重启后: ${techAfter.budget_total}`);
    }
  } else {
    failed++;
    console.log(`  获取重启后部门数据失败: ${deptAfterRestart.error}`);
  }

  const adjAfterRestart = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  if (adjAfterRestart.success && adjAfterRestart.data.adjustments) {
    const reversedAfter = adjAfterRestart.data.adjustments.filter(a => a.is_reversed).length;
    if (logTest('重启后冲正状态保持一致',
        reversedAfter === reversedBefore)) {
      passed++;
      console.log(`  已冲正记录: ${reversedAfter} 条`);
    } else {
      failed++;
      console.log(`  重启前: ${reversedBefore} 条, 重启后: ${reversedAfter} 条`);
    }

    const sampleReversed = adjAfterRestart.data.adjustments.find(a => a.is_reversed);
    if (sampleReversed && logTest('重启后冲正详情完整',
        sampleReversed.reversed_by_name &&
        sampleReversed.reversal_reason &&
        sampleReversed.reversed_at)) {
      passed++;
      console.log(`  冲正记录 #${sampleReversed.id}: 冲正人=${sampleReversed.reversed_by_name}, 原因=${sampleReversed.reversal_reason}`);
    } else {
      failed++;
      console.log(`  冲正详情不完整: ${JSON.stringify(sampleReversed)}`);
    }
  } else {
    failed += 2;
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
  console.log('  测试场景 13: 申请人可查看冲正状态');
  console.log('========================================\n');

  res = await apiRequest('GET', '/budget-adjustments', tokens.zhangsan);
  if (logTest('申请人可查看调整历史(含冲正状态)',
      res.status === 200 &&
      res.data.adjustments.length > 0 &&
      res.data.adjustments.some(a => a.is_reversed))) {
    passed++;
    const reversedAdj = res.data.adjustments.find(a => a.is_reversed);
    console.log(`  申请人可看到已冲正记录 #${reversedAdj.id}`);
    console.log(`  冲正人: ${reversedAdj.reversed_by_name}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 记录数: ${res.data.adjustments?.length || 0}`);
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
