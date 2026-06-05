const axios = require('axios');
const { exec, spawn } = require('child_process');
const path = require('path');

const API_BASE = 'http://localhost:3000/api';
let serverProcess = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function killPort(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
      if (err || !stdout) {
        resolve();
        return;
      }
      const pids = [...new Set(stdout.trim().split('\n').map(line => {
        const m = line.match(/\s+(\d+)\s*$/);
        return m ? parseInt(m[1]) : null;
      }).filter(Boolean))];
      if (pids.length > 0) {
        exec(`taskkill /F ${pids.map(p => `/PID ${p}`).join(' ')}`, () => {
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
      stdio: 'pipe'
    });

    serverProcess.stderr.on('data', (data) => {
      console.log('[SERVER ERR]', data.toString().trim());
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      console.log(`[SERVER EXIT] code=${code}`);
    });

    const checkServer = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          await axios.get(`${API_BASE}/health`);
          resolve();
          return;
        } catch (e) {
          await sleep(500);
        }
      }
      reject(new Error('Server failed to start'));
    };
    checkServer();
  });
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    await sleep(1000);
  }
}

async function login(username, password) {
  const res = await axios.post(`${API_BASE}/auth/login`, { username, password });
  return res.data.token;
}

async function initDb() {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['scripts/init-db.js'], {
      cwd: __dirname,
      stdio: 'ignore'
    });
    p.on('exit', (code) => code === 0 ? resolve() : reject(code));
    p.on('error', reject);
  });
}

async function checkServerAlive() {
  try {
    const res = await axios.get(`${API_BASE}/health`, { timeout: 2000 });
    return res.status === 200;
  } catch (e) {
    return false;
  }
}

async function apiRequest(method, url, token, data = null) {
  try {
    const res = await axios({
      method,
      url: `${API_BASE}${url}`,
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 10000,
      validateStatus: () => true
    });
    return { success: res.status >= 200 && res.status < 300, status: res.status, data: res.data, error: res.data?.error };
  } catch (e) {
    return { success: false, status: e.code, data: null, error: e.message };
  }
}

async function main() {
  console.log('=== 并发调减预算回归测试 ===\n');

  console.log('1. 初始化数据库...');
  await initDb();

  console.log('2. 启动服务...');
  await startServer();

  console.log('3. 登录财务账号...');
  const token = await login('qianqi', '123456');

  console.log('4. 先给技术部追加预算，确保有足够预算可调减...');
  const r = await apiRequest('POST', '/budget-adjustments', token, {
    departmentId: 1,
    adjustmentType: 'increase',
    amount: 100000,
    reason: '初始追加，为并发调减准备'
  });
  console.log('   追加结果:', r.success ? '成功' : '失败', r.data?.department?.budget_total);

  console.log('\n5. 关键测试：同时发起两笔调减请求（真正并发）');
  console.log('   技术部当前总预算:', r.data.department.budget_total);
  console.log('   调减金额: 每笔 40000，两笔共 80000');

  const payload = {
    departmentId: 1,
    adjustmentType: 'decrease',
    amount: 40000,
    reason: '并发调减测试'
  };

  const t0 = Date.now();
  const [req1, req2] = await Promise.all([
    apiRequest('POST', '/budget-adjustments', token, { ...payload, reason: '并发调减 #1' }),
    apiRequest('POST', '/budget-adjustments', token, { ...payload, reason: '并发调减 #2' })
  ]);
  const elapsed = Date.now() - t0;

  console.log(`\n   两笔请求在 ${elapsed}ms 内完成`);
  console.log('   请求1:', req1.success ? '成功' : '失败', req1.status, req1.error || '');
  console.log('   请求2:', req2.success ? '成功' : '失败', req2.status, req2.error || '');

  const alive = await checkServerAlive();
  console.log('\n6. 检查服务是否存活:', alive ? '✅ 存活' : '❌ 崩溃');

  if (alive) {
    const dept = await apiRequest('GET', '/departments', token);
    const techDept = dept.data.departments.find(d => d.id === 1);
    console.log('\n7. 检查最终预算:');
    console.log('   总预算:', techDept.budget_total);
    console.log('   预期: 200000 - 成功次数 * 40000');

    const adj = await apiRequest('GET', '/budget-adjustments', token);
    const techAdj = adj.data.adjustments.filter(a => a.department_id === 1 && a.adjustment_type === 'decrease');
    console.log('\n8. 审计记录:');
    console.log('   调减记录数:', techAdj.length);
    techAdj.forEach((a, i) => {
      console.log(`   ${i + 1}. ${a.budget_before} -> ${a.budget_after} (${a.amount}) by ${a.user_name}`);
    });

    const successCount = (req1.success ? 1 : 0) + (req2.success ? 1 : 0);
    const expectedBudget = 200000 - successCount * 40000;
    const budgetCorrect = Math.abs(techDept.budget_total - expectedBudget) < 0.01;
    const adjCountCorrect = techAdj.length === successCount;
    const noNegative = techDept.budget_total >= 0 && techAdj.every(a => a.budget_after >= 0 && a.budget_before >= 0);

    console.log('\n9. 数据一致性检查:');
    console.log('   预算金额正确:', budgetCorrect ? '✅' : '❌', `预期=${expectedBudget}, 实际=${techDept.budget_total}`);
    console.log('   审计记录数量正确:', adjCountCorrect ? '✅' : '❌', `预期=${successCount}, 实际=${techAdj.length}`);
    console.log('   无负数预算:', noNegative ? '✅' : '❌');

    console.log('\n10. 账本一致性检查:');
    const check = await apiRequest('GET', '/ledger/check', token);
    console.log('   整体一致:', check.data.overallConsistent ? '✅' : '❌');
    if (check.data.inconsistencies?.length > 0) {
      check.data.inconsistencies.forEach(i => console.log('   -', i.message));
    }

    console.log('\n11. CSV 导出检查:');
    const exportRes = await apiRequest('GET', '/ledger/export', token);
    const hasAdjRecords = exportRes.data.includes('预算调整');
    const hasReasons = exportRes.data.includes('并发调减');
    const hasRecordType = exportRes.data.includes('记录类型');
    console.log('   包含记录类型列:', hasRecordType ? '✅' : '❌');
    console.log('   包含预算调整记录:', hasAdjRecords ? '✅' : '❌');
    console.log('   包含调整原因:', hasReasons ? '✅' : '❌');

    console.log('\n12. 重启后数据验证:');
    await stopServer();
    await sleep(2000);
    await startServer();
    const token2 = await login('qianqi', '123456');
    const dept2 = await apiRequest('GET', '/departments', token2);
    const techDept2 = dept2.data.departments.find(d => d.id === 1);
    const adj2 = await apiRequest('GET', '/budget-adjustments', token2);
    const techAdj2 = adj2.data.adjustments.filter(a => a.department_id === 1 && a.adjustment_type === 'decrease');
    console.log('   重启后总预算:', techDept2.budget_total, Math.abs(techDept2.budget_total - expectedBudget) < 0.01 ? '✅' : '❌');
    console.log('   重启后调减记录数:', techAdj2.length, techAdj2.length === successCount ? '✅' : '❌');

    const allPass = alive && budgetCorrect && adjCountCorrect && noNegative && 
                   check.data.overallConsistent && hasRecordType && hasAdjRecords && hasReasons &&
                   Math.abs(techDept2.budget_total - expectedBudget) < 0.01 &&
                   techAdj2.length === successCount;

    console.log('\n=== 测试结果 ===');
    console.log(allPass ? '✅ 全部通过' : '❌ 存在失败');
    await stopServer();
    process.exit(allPass ? 0 : 1);
  } else {
    console.log('\n❌ 服务崩溃，测试失败');
    await stopServer();
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('测试异常:', e);
  await stopServer();
  process.exit(1);
});
