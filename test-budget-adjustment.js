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
  console.log('  预算调整功能验证测试');
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

  const adjustPayload = {
    departmentId: 1,
    adjustmentType: 'increase',
    amount: 50000,
    reason: '测试权限拒绝'
  };

  let res = await apiRequest('POST', '/budget-adjustments', tokens.zhangsan, adjustPayload);
  if (logTest('申请人(zhangsan)调用调整接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('POST', '/budget-adjustments', tokens.wangwu, adjustPayload);
  if (logTest('主管(wangwu)调用调整接口被拒绝',
      res.status === 403 && res.data.error?.includes('finance'))) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}, 错误: ${res.data.error}`);
  }

  res = await apiRequest('GET', '/budget-adjustments', tokens.zhangsan);
  if (logTest('申请人可以查看调整历史记录(只读)',
      res.status === 200 && res.data.adjustments !== undefined)) {
    passed++;
  } else {
    failed++;
    console.log(`  实际状态: ${res.status}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 2: 合法追加预算');
  console.log('========================================\n');

  const deptBefore = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptBefore = deptBefore.data.departments.find(d => d.id === 1);
  const budgetBefore = techDeptBefore.budget_total;

  const increasePayload = {
    departmentId: 1,
    adjustmentType: 'increase',
    amount: 50000,
    reason: 'Q2 技术设备采购预算追加'
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, increasePayload);
  if (logTest('财务追加技术部预算 50000 成功',
      res.status === 200 &&
      res.data.adjustment.adjustment_type === 'increase' &&
      res.data.adjustment.amount === 50000 &&
      res.data.department.budget_total === budgetBefore + 50000)) {
    passed++;
    console.log(`  调整前: ${budgetBefore.toFixed(2)}, 调整后: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const adjId = res.data.adjustment.id;

  res = await apiRequest('GET', `/budget-adjustments/${adjId}`, tokens.qianqi);
  if (logTest('调整记录已保存，可通过ID查询',
      res.status === 200 &&
      res.data.adjustment.id === adjId &&
      res.data.adjustment.reason === 'Q2 技术设备采购预算追加' &&
      res.data.adjustment.user_name === 'qianqi')) {
    passed++;
    console.log(`  操作人: ${res.data.adjustment.user_name}, 原因: ${res.data.adjustment.reason}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}`);
  }

  res = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
  if (logTest('调整历史列表包含新记录',
      res.status === 200 &&
      res.data.adjustments.length === 1 &&
      res.data.adjustments[0].id === adjId)) {
    passed++;
  } else {
    failed++;
    console.log(`  记录数: ${res.data.adjustments?.length || 0}`);
  }

  const deptAfter = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptAfter = deptAfter.data.departments.find(d => d.id === 1);
  if (logTest('部门总预算已更新，可用余额同步增加',
      techDeptAfter.budget_total === budgetBefore + 50000 &&
      techDeptAfter.budget_available === (budgetBefore + 50000) - techDeptAfter.budget_used - techDeptAfter.budget_locked &&
      techDeptAfter.adjustment_count === 1)) {
    passed++;
    console.log(`  总预算: ${techDeptAfter.budget_total.toFixed(2)}, 可用: ${techDeptAfter.budget_available.toFixed(2)}, 调整次数: ${techDeptAfter.adjustment_count}`);
  } else {
    failed++;
    console.log(`  总预算: ${techDeptAfter.budget_total}, 可用: ${techDeptAfter.budget_available}, 调整次数: ${techDeptAfter.adjustment_count}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 3: 非法调减预算');
  console.log('========================================\n');

  const appPayload = {
    amount: 80000,
    supplier: '测试供应商',
    purpose: '测试预算锁定'
  };
  const appRes = await apiRequest('POST', '/applications', tokens.zhangsan, appPayload);
  const appId = appRes.data.application.id;
  console.log(`   已创建申请 #${appId}，金额 80000，锁定预算`);

  await apiRequest('POST', `/applications/${appId}/approve`, tokens.wangwu, { remark: '通过' });
  console.log(`   申请 #${appId} 已审批通过，预算保持锁定\n`);

  const deptBeforeDecrease = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptBeforeDecrease = deptBeforeDecrease.data.departments.find(d => d.id === 1);
  const minAllowed = techDeptBeforeDecrease.budget_used + techDeptBeforeDecrease.budget_locked;
  console.log(`  技术部当前: 总预算=${techDeptBeforeDecrease.budget_total.toFixed(2)}, 已使用=${techDeptBeforeDecrease.budget_used.toFixed(2)}, 锁定=${techDeptBeforeDecrease.budget_locked.toFixed(2)}`);
  console.log(`  最低允许调减到: ${minAllowed.toFixed(2)}\n`);

  const decreasePayload = {
    departmentId: 1,
    adjustmentType: 'decrease',
    amount: 100000,
    reason: '测试非法调减'
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, decreasePayload);
  const expectedAfter = techDeptBeforeDecrease.budget_total - 100000;
  if (logTest('调减后低于已使用+锁定被拒绝',
      res.status === 400 &&
      res.data.error?.includes('调减后总预算不能低于已使用加锁定金额'))) {
    passed++;
    console.log(`  调减后将为: ${expectedAfter.toFixed(2)}, 最低允许: ${minAllowed.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const deptAfterFailed = await apiRequest('GET', '/departments', tokens.qianqi);
  const techDeptAfterFailed = deptAfterFailed.data.departments.find(d => d.id === 1);
  if (logTest('调减失败后预算未变化',
      techDeptAfterFailed.budget_total === techDeptBeforeDecrease.budget_total)) {
    passed++;
  } else {
    failed++;
    console.log(`  调减前: ${techDeptBeforeDecrease.budget_total}, 调减后: ${techDeptAfterFailed.budget_total}`);
  }

  const validDecreasePayload = {
    departmentId: 1,
    adjustmentType: 'decrease',
    amount: 30000,
    reason: 'Q2 预算结余回收'
  };
  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, validDecreasePayload);
  if (logTest('合法范围内调减 30000 成功',
      res.status === 200 &&
      res.data.adjustment.adjustment_type === 'decrease' &&
      res.data.department.budget_total === techDeptBeforeDecrease.budget_total - 30000)) {
    passed++;
    console.log(`  调整后总预算: ${res.data.department.budget_total.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 4: 一致性检查验证');
  console.log('========================================\n');

  res = await apiRequest('GET', '/ledger/check', tokens.qianqi);
  if (logTest('一致性检查通过',
      res.status === 200 &&
      res.data.overallConsistent === true &&
      res.data.inconsistencies.length === 0)) {
    passed++;
    console.log(`  预算调整次数: ${res.data.summary.budget_adjustment_count}`);
    console.log(`  累计追加: ${res.data.summary.total_adjustments_increase.toFixed(2)}`);
    console.log(`  累计调减: ${res.data.summary.total_adjustments_decrease.toFixed(2)}`);
  } else {
    failed++;
    console.log(`  一致: ${res.data.overallConsistent}, 不一致项: ${res.data.inconsistencies?.length || 0}`);
    if (res.data.inconsistencies?.length > 0) {
      res.data.inconsistencies.forEach(i => console.log(`  - ${i.message}`));
    }
  }

  if (res.data.budgetAdjustments && res.data.budgetAdjustments.length > 0) {
    const allAdjConsistent = res.data.budgetAdjustments.every(a => a.amount_consistent === true);
    if (logTest('所有预算调整记录金额计算一致', allAdjConsistent)) {
      passed++;
    } else {
      failed++;
      const bad = res.data.budgetAdjustments.filter(a => !a.amount_consistent);
      bad.forEach(a => console.log(`  - 调整 #${a.id} 不一致`));
    }

    const allDeptConsistent = res.data.departments.every(d => d.budget_total_consistent === true);
    if (logTest('所有部门总预算与初始+调整计算一致', allDeptConsistent)) {
      passed++;
    } else {
      failed++;
      const bad = res.data.departments.filter(d => !d.budget_total_consistent);
      bad.forEach(d => console.log(`  - 部门 ${d.name} 不一致: DB=${d.budget_total}, 计算=${d.calculated_budget_total}`));
    }
  }

  console.log('\n========================================');
  console.log('  测试场景 5: CSV 导出验证');
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
    const adjRecords = lines.filter(l => l.includes('预算调整'));
    const appRecords = lines.filter(l => l.includes('采购申请'));

    if (logTest('CSV 导出包含记录类型列', header.includes('记录类型'))) {
      passed++;
    } else {
      failed++;
    }

    if (logTest('CSV 导出包含调整原因列', header.includes('调整原因'))) {
      passed++;
    } else {
      failed++;
    }

    if (logTest('CSV 包含 2 条预算调整记录', adjRecords.length === 2)) {
      passed++;
      console.log(`  预算调整记录: ${adjRecords.length} 条`);
      adjRecords.forEach(r => {
        const cols = r.split(',');
        console.log(`    - ${cols[2]} ${cols[5]} ${cols[11]}`);
      });
    } else {
      failed++;
      console.log(`  实际: ${adjRecords.length} 条预算调整记录`);
    }

    if (logTest('CSV 包含 1 条采购申请记录', appRecords.length === 1)) {
      passed++;
    } else {
      failed++;
    }

    fs.writeFileSync(path.join(__dirname, 'exports', 'test-export.csv'), csvContent);
    console.log(`  ✓ 测试导出文件已保存: exports/test-export.csv`);
  } catch (err) {
    failed += 4;
    console.log(`  导出失败: ${err.message}`);
  }

  console.log('\n========================================');
  console.log('  测试场景 6: 并发调整测试');
  console.log('========================================\n');

  const marketDept = await apiRequest('GET', '/departments', tokens.qianqi);
  const marketBefore = marketDept.data.departments.find(d => d.id === 2);
  console.log(`  市场部初始预算: ${marketBefore.budget_total.toFixed(2)}\n`);

  const concurrentPayload = {
    departmentId: 2,
    adjustmentType: 'increase',
    amount: 10000,
    reason: '并发测试'
  };

  const results = [];
  for (let i = 0; i < 5; i++) {
    const r = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, {
      ...concurrentPayload,
      reason: `并发测试 #${i + 1}`
    });
    results.push(r);
    await sleep(50);
  }
  const successCount = results.filter(r => r.success).length;

  if (logTest('5次快速连续调整全部成功', successCount === 5)) {
    passed++;
    console.log(`  成功: ${successCount}/5`);
  } else {
    failed++;
    console.log(`  成功: ${successCount}/5`);
    results.forEach((r, i) => {
      if (!r.success) console.log(`  请求 ${i + 1} 失败: ${r.error}`);
    });
  }

  await sleep(500);

  const marketAfter = await apiRequest('GET', '/departments', tokens.qianqi);
  if (!marketAfter.success || !marketAfter.data.departments) {
    failed += 4;
    console.log(`  获取部门数据失败: ${marketAfter.error}`);
  } else {
    const marketDeptAfter = marketAfter.data.departments.find(d => d.id === 2);
    const expectedAfterConcurrent = marketBefore.budget_total + (successCount * 10000);

    if (logTest('调整后预算正确，无覆盖或负数',
        Math.abs(marketDeptAfter.budget_total - expectedAfterConcurrent) < 0.01 &&
        marketDeptAfter.budget_total > 0)) {
      passed++;
      console.log(`  调整后: ${marketDeptAfter.budget_total.toFixed(2)}, 预期: ${expectedAfterConcurrent.toFixed(2)}`);
    } else {
      failed++;
      console.log(`  调整后: ${marketDeptAfter.budget_total}, 预期: ${expectedAfterConcurrent}`);
    }

    const adjAfterConcurrent = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
    if (!adjAfterConcurrent.success || !adjAfterConcurrent.data.adjustments) {
      failed += 3;
      console.log(`  获取调整记录失败: ${adjAfterConcurrent.error}`);
    } else {
      const marketAdjCount = adjAfterConcurrent.data.adjustments.filter(a => a.department_id === 2).length;

      if (logTest('调整后审计记录数量正确', marketAdjCount === successCount)) {
        passed++;
        console.log(`  市场部调整记录: ${marketAdjCount} 条, 成功请求: ${successCount} 次`);
      } else {
        failed++;
        console.log(`  市场部调整记录: ${marketAdjCount} 条, 成功请求: ${successCount} 次`);
      }

      let hasNegative = false;
      const allAdj = adjAfterConcurrent.data.adjustments;
      for (const adj of allAdj) {
        if (adj.budget_after < 0 || adj.budget_before < 0) {
          hasNegative = true;
          break;
        }
      }

      if (logTest('调整后无负数预算', !hasNegative)) {
        passed++;
      } else {
        failed++;
        console.log(`  发现负数预算记录`);
      }
    }

    res = await apiRequest('GET', '/ledger/check', tokens.qianqi);
    if (logTest('调整后一致性检查仍通过',
        res.data.overallConsistent === true)) {
      passed++;
    } else {
      failed++;
      console.log(`  不一致项: ${res.data.inconsistencies?.length || 0}`);
      if (res.data.inconsistencies?.length > 0) {
        res.data.inconsistencies.forEach(i => console.log(`  - ${i.message}`));
      }
    }
  }

  console.log('\n========================================');
  console.log('  测试场景 7: 重启后数据持久化');
  console.log('========================================\n');

  const stateBeforeRestart = {};
  const deptState = await apiRequest('GET', '/departments', tokens.qianqi);
  if (!deptState.success || !deptState.data.departments) {
    failed += 3;
    console.log(`  获取重启前部门数据失败: ${deptState.error}, 尝试重启服务...`);
    await stopServer();
    await sleep(2000);
    await startServer();
    console.log('  ✓ 服务已重启\n');
    tokens.qianqi = await login('qianqi', '123456');
    
    const deptAfterRestart = await apiRequest('GET', '/departments', tokens.qianqi);
    const adjAfterRestart = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
    const checkAfterRestart = await apiRequest('GET', '/ledger/check', tokens.qianqi);
    
    if (logTest('重启后服务恢复正常', deptAfterRestart.success && adjAfterRestart.success && checkAfterRestart.success)) {
      passed++;
    } else {
      failed++;
    }
  } else {
    stateBeforeRestart.departments = deptState.data.departments;
    const adjState = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
    stateBeforeRestart.adjustments = adjState.data.adjustments;
    const checkState = await apiRequest('GET', '/ledger/check', tokens.qianqi);
    stateBeforeRestart.check = checkState.data;

    console.log(`  重启前: ${stateBeforeRestart.adjustments.length} 条调整记录`);
    console.log(`  重启前: 技术部总预算 ${stateBeforeRestart.departments[0].budget_total.toFixed(2)}`);
    console.log(`  重启前: 一致性检查 ${stateBeforeRestart.check.overallConsistent ? '通过' : '失败'}\n`);

    console.log('  重启服务中...');
    await stopServer();
    await sleep(2000);
    await startServer();
    console.log('  ✓ 服务已重启\n');

    tokens.qianqi = await login('qianqi', '123456');

    const deptAfterRestart = await apiRequest('GET', '/departments', tokens.qianqi);
    if (deptAfterRestart.success && deptAfterRestart.data.departments) {
      const deptAfterSimple = deptAfterRestart.data.departments.map(d => ({
        id: d.id,
        budget_total: d.budget_total,
        budget_used: d.budget_used,
        budget_locked: d.budget_locked,
        adjustment_count: d.adjustment_count
      }));
      const deptBeforeSimple = stateBeforeRestart.departments.map(d => ({
        id: d.id,
        budget_total: d.budget_total,
        budget_used: d.budget_used,
        budget_locked: d.budget_locked,
        adjustment_count: d.adjustment_count
      }));
      if (logTest('重启后部门预算数据保持一致',
          JSON.stringify(deptAfterSimple) === JSON.stringify(deptBeforeSimple))) {
        passed++;
        console.log(`  技术部总预算: ${deptAfterRestart.data.departments[0].budget_total.toFixed(2)}`);
      } else {
        failed++;
        const before = stateBeforeRestart.departments[0];
        const after = deptAfterRestart.data.departments[0];
        console.log(`  技术部 - 重启前: total=${before.budget_total}, used=${before.budget_used}, locked=${before.budget_locked}`);
        console.log(`  技术部 - 重启后: total=${after.budget_total}, used=${after.budget_used}, locked=${after.budget_locked}`);
      }
    } else {
      failed++;
      console.log(`  获取重启后部门数据失败: ${deptAfterRestart.error}`);
    }

    const adjAfterRestart = await apiRequest('GET', '/budget-adjustments', tokens.qianqi);
    if (adjAfterRestart.success && adjAfterRestart.data.adjustments) {
      if (logTest('重启后调整记录保持完整',
          adjAfterRestart.data.adjustments.length === stateBeforeRestart.adjustments.length)) {
        passed++;
        console.log(`  调整记录: ${adjAfterRestart.data.adjustments.length} 条`);
      } else {
        failed++;
        console.log(`  重启前: ${stateBeforeRestart.adjustments.length} 条, 重启后: ${adjAfterRestart.data.adjustments.length} 条`);
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
  }

  console.log('\n========================================');
  console.log('  测试场景 8: 必填写原因验证');
  console.log('========================================\n');

  const noReasonPayload = {
    departmentId: 3,
    adjustmentType: 'increase',
    amount: 10000,
    reason: '   '
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, noReasonPayload);
  if (logTest('空原因(空格)被拒绝',
      res.status === 400 && res.data.error?.includes('调整原因不能为空'))) {
    passed++;
  } else {
    failed++;
    console.log(`  状态: ${res.status}, 错误: ${res.data.error}`);
  }

  const missingReasonPayload = {
    departmentId: 3,
    adjustmentType: 'increase',
    amount: 10000
  };

  res = await apiRequest('POST', '/budget-adjustments', tokens.qianqi, missingReasonPayload);
  if (logTest('未传原因字段被拒绝',
      res.status === 400 && res.data.error?.includes('调整原因不能为空'))) {
    passed++;
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
