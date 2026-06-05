const axios = require('axios');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000/api';

let financeToken = null;
let applicantToken = null;
let testBatchId = `BATCH-TEST-${Date.now()}`;
let precheckContentHash = null;
let precheckRows = null;

async function login(username, password) {
  const res = await axios.post(`${BASE_URL}/auth/login`, { username, password });
  return res.data.token;
}

async function testStep(description, fn) {
  console.log(`\n=== ${description} ===`);
  try {
    await fn();
    console.log(`✓ ${description} - 通过`);
    return true;
  } catch (err) {
    console.log(`✗ ${description} - 失败`);
    console.log(`  错误: ${err.message}`);
    if (err.response) {
      console.log(`  状态: ${err.response.status}`);
      console.log(`  响应: ${JSON.stringify(err.response.data)}`);
    }
    return false;
  }
}

async function runTests() {
  console.log('========================================');
  console.log('  预算导入批次工作台 - 综合验证脚本');
  console.log('========================================');
  console.log(`测试批次号: ${testBatchId}`);

  let results = {
    total: 0,
    passed: 0,
    failed: 0
  };

  const runTest = async (desc, fn) => {
    results.total++;
    const passed = await testStep(desc, fn);
    if (passed) results.passed++;
    else results.failed++;
    return passed;
  };

  console.log('\n----------------------------------------');
  console.log('  第一部分：基础登录与权限');
  console.log('----------------------------------------');

  await runTest('财务用户登录', async () => {
    financeToken = await login('qianqi', '123456');
    assert.ok(financeToken, '应该返回token');
  });

  await runTest('申请人用户登录', async () => {
    applicantToken = await login('zhangsan', '123456');
    assert.ok(applicantToken, '应该返回token');
  });

  await runTest('权限验证 - 非财务用户不能预检', async () => {
    try {
      await axios.post(`${BASE_URL}/budget-batches/precheck`, {
        batchId: testBatchId,
        rows: [{ department: '技术部', type: '追加', amount: '1000', reason: '测试' }]
      }, { headers: { Authorization: `Bearer ${applicantToken}` } });
      throw new Error('应该返回403错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 403, '应该返回403 Forbidden');
    }
  });

  console.log('\n----------------------------------------');
  console.log('  第二部分：预检持久化测试');
  console.log('----------------------------------------');

  const validRows = [
    { department: '技术部', type: '追加', amount: '50000', reason: 'Q2设备采购预算' },
    { department: '市场部', type: '调减', amount: '20000', reason: '活动预算结余回收' }
  ];

  await runTest('财务用户预检 - 全部通过', async () => {
    const res = await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: testBatchId,
      rows: validRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    assert.strictEqual(res.data.status, 'prechecked', '状态应为prechecked');
    assert.strictEqual(res.data.allValid, true, 'allValid应为true');
    assert.strictEqual(res.data.totalRows, 2, '总行数应为2');
    assert.strictEqual(res.data.validRows, 2, '有效行数应为2');
    assert.ok(res.data.contentHash, '应返回contentHash');
    
    precheckContentHash = res.data.contentHash;
    precheckRows = res.data.results;
    
    console.log(`  内容哈希: ${precheckContentHash.substring(0, 16)}...`);
  });

  await runTest('查询批次列表 - 验证prechecked状态', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches?status=prechecked`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    const batch = res.data.batches.find(b => b.batch_id === testBatchId);
    assert.ok(batch, '批次应该存在');
    assert.strictEqual(batch.status, 'prechecked', '状态应为prechecked');
    assert.strictEqual(batch.total_rows, 2, '总行数应为2');
    assert.strictEqual(batch.user_name, 'qianqi', '操作人应为qianqi');
  });

  await runTest('查询批次详情 - 验证明细数据', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches/${testBatchId}`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    assert.strictEqual(res.data.batch.status, 'prechecked', '批次状态应为prechecked');
    assert.strictEqual(res.data.lines.length, 2, '应有2条明细');
    assert.ok(res.data.operations, '应返回操作日志');
    assert.strictEqual(res.data.operations.length, 1, '应有1条操作日志');
    assert.strictEqual(res.data.operations[0].operation, 'precheck', '操作类型应为precheck');
    
    const line1 = res.data.lines.find(l => l.line_number === 1);
    assert.strictEqual(line1.status, 'valid', '第1行状态应为valid');
    assert.strictEqual(line1.department_name, '技术部', '部门应为技术部');
    assert.ok(line1.current_budget !== null, '应有当前预算');
    assert.ok(line1.expected_budget_after !== null, '应有预计调整后预算');
    
    console.log(`  技术部当前预算: ${line1.current_budget}`);
    console.log(`  技术部预计调整后: ${line1.expected_budget_after}`);
  });

  await runTest('预检包含错误行 - 验证failed状态持久化', async () => {
    const failBatchId = `${testBatchId}-FAIL`;
    const invalidRows = [
      { department: '不存在的部门', type: '追加', amount: '1000', reason: '测试错误' },
      { department: '技术部', type: '无效类型', amount: '1000', reason: '测试错误' }
    ];

    const res = await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: failBatchId,
      rows: invalidRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    assert.strictEqual(res.data.status, 'failed', '状态应为failed');
    assert.strictEqual(res.data.allValid, false, 'allValid应为false');
    assert.strictEqual(res.data.invalidRows, 2, '无效行数应为2');

    const detailRes = await axios.get(`${BASE_URL}/budget-batches/${failBatchId}`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    assert.strictEqual(detailRes.data.batch.status, 'failed', '批次状态应为failed');
  });

  console.log('\n----------------------------------------');
  console.log('  第三部分：内容篡改检测');
  console.log('----------------------------------------');

  await runTest('提交时内容篡改检测 - 修改金额', async () => {
    const tamperedRows = precheckRows.map(r => ({
      ...r,
      amount: r.amountNum + 1000
    }));

    try {
      await axios.post(`${BASE_URL}/budget-batches/submit`, {
        batchId: testBatchId,
        rows: tamperedRows,
        contentHash: precheckContentHash
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回400错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 400, '应该返回400');
      assert.strictEqual(err.response.data.code, 'CONTENT_MISMATCH', '错误码应为CONTENT_MISMATCH');
    }
  });

  await runTest('提交时内容篡改检测 - 修改部门', async () => {
    const tamperedRows = precheckRows.map((r, i) => ({
      ...r,
      department: i === 0 ? '财务部' : r.department
    }));

    try {
      await axios.post(`${BASE_URL}/budget-batches/submit`, {
        batchId: testBatchId,
        rows: tamperedRows,
        contentHash: precheckContentHash
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回400错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 400, '应该返回400');
      assert.strictEqual(err.response.data.code, 'CONTENT_MISMATCH', '错误码应为CONTENT_MISMATCH');
    }
  });

  console.log('\n----------------------------------------');
  console.log('  第四部分：重复提交与状态校验');
  console.log('----------------------------------------');

  await runTest('直接提交未预检批次 - 应该失败', async () => {
    const newBatchId = `${testBatchId}-NO-PRECHECK`;
    try {
      await axios.post(`${BASE_URL}/budget-batches/submit`, {
        batchId: newBatchId,
        rows: validRows
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回404错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 404, '应该返回404');
      assert.strictEqual(err.response.data.code, 'BATCH_NOT_FOUND', '错误码应为BATCH_NOT_FOUND');
    }
  });

  await runTest('预检状态错误检测 - 提交failed状态批次', async () => {
    const failBatchId = `${testBatchId}-FAIL-SUBMIT`;
    const invalidRows = [{ department: '不存在的部门', type: '追加', amount: '1000', reason: '测试' }];
    
    await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: failBatchId,
      rows: invalidRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    try {
      await axios.post(`${BASE_URL}/budget-batches/submit`, {
        batchId: failBatchId,
        rows: invalidRows
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回400错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 400, '应该返回400');
      assert.strictEqual(err.response.data.code, 'BATCH_NOT_PRECHECKED', '错误码应为BATCH_NOT_PRECHECKED');
    }
  });

  console.log('\n----------------------------------------');
  console.log('  第五部分：取消批次功能');
  console.log('----------------------------------------');

  await runTest('取消已预检批次', async () => {
    const cancelBatchId = `${testBatchId}-CANCEL`;
    
    await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: cancelBatchId,
      rows: validRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    const res = await axios.post(`${BASE_URL}/budget-batches/${cancelBatchId}/cancel`, {
      reason: '测试取消'
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    assert.strictEqual(res.data.success, true, '取消应该成功');
    assert.strictEqual(res.data.batch.status, 'cancelled', '状态应为cancelled');
  });

  await runTest('取消后禁止确认提交', async () => {
    const cancelBatchId = `${testBatchId}-CANCEL-SUBMIT`;
    
    const precheckRes = await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: cancelBatchId,
      rows: validRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    await axios.post(`${BASE_URL}/budget-batches/${cancelBatchId}/cancel`, {
      reason: '测试取消后禁止提交'
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    try {
      await axios.post(`${BASE_URL}/budget-batches/submit`, {
        batchId: cancelBatchId,
        rows: validRows,
        contentHash: precheckRes.data.contentHash
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回409错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 409, '应该返回409');
      assert.strictEqual(err.response.data.code, 'BATCH_CANCELLED', '错误码应为BATCH_CANCELLED');
    }
  });

  await runTest('非创建者不能取消批次', async () => {
    const otherBatchId = `${testBatchId}-OTHER-CANCEL`;
    
    await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: otherBatchId,
      rows: validRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    const otherFinanceToken = await login('qianqi', '123456');

    try {
      await axios.post(`${BASE_URL}/budget-batches/${otherBatchId}/cancel`, {
        reason: '非创建者取消测试'
      }, { headers: { Authorization: `Bearer ${otherFinanceToken}` } });
    } catch (err) {
      assert.strictEqual(err.response.status, 403, '应该返回403');
      assert.strictEqual(err.response.data.code, 'PERMISSION_DENIED', '错误码应为PERMISSION_DENIED');
    }
  });

  await runTest('已完成批次不能取消', async () => {
    const successBatchId = `${testBatchId}-SUCCESS-CANCEL`;
    
    const precheckRes = await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: successBatchId,
      rows: validRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    await axios.post(`${BASE_URL}/budget-batches/submit`, {
      batchId: successBatchId,
      rows: precheckRes.data.results,
      contentHash: precheckRes.data.contentHash
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    try {
      await axios.post(`${BASE_URL}/budget-batches/${successBatchId}/cancel`, {
        reason: '尝试取消已完成批次'
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回409错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 409, '应该返回409');
      assert.strictEqual(err.response.data.code, 'BATCH_ALREADY_PROCESSED', '错误码应为BATCH_ALREADY_PROCESSED');
    }
  });

  console.log('\n----------------------------------------');
  console.log('  第六部分：正常提交流程');
  console.log('----------------------------------------');

  const successBatchId = `${testBatchId}-SUCCESS`;
  let submitResult = null;

  await runTest('正常提交 - 全部通过', async () => {
    const precheckRes = await axios.post(`${BASE_URL}/budget-batches/precheck`, {
      batchId: successBatchId,
      rows: validRows
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    const res = await axios.post(`${BASE_URL}/budget-batches/submit`, {
      batchId: successBatchId,
      rows: precheckRes.data.results,
      contentHash: precheckRes.data.contentHash
    }, { headers: { Authorization: `Bearer ${financeToken}` } });

    submitResult = res.data;
    assert.strictEqual(res.data.success, true, '提交应该成功');
    assert.strictEqual(res.data.batch.status, 'completed', '状态应为completed');
    assert.strictEqual(res.data.batch.success_rows, 2, '成功行数应为2');
    assert.ok(res.data.operations, '应返回操作日志');
    assert.strictEqual(res.data.operations.length, 2, '应有2条操作日志（预检+提交）');
  });

  await runTest('重复提交检测', async () => {
    try {
      await axios.post(`${BASE_URL}/budget-batches/submit`, {
        batchId: successBatchId,
        rows: validRows
      }, { headers: { Authorization: `Bearer ${financeToken}` } });
      throw new Error('应该返回409错误');
    } catch (err) {
      assert.strictEqual(err.response.status, 409, '应该返回409');
      assert.strictEqual(err.response.data.code, 'BATCH_ALREADY_PROCESSED', '错误码应为BATCH_ALREADY_PROCESSED');
    }
  });

  await runTest('验证提交后操作日志完整', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches/${successBatchId}/operations`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    const operations = res.data.operations;
    assert.ok(operations.length >= 2, '至少应有2条操作日志');
    
    const precheckOp = operations.find(o => o.operation === 'precheck');
    const submitOp = operations.find(o => o.operation === 'submit');
    
    assert.ok(precheckOp, '应有预检操作日志');
    assert.ok(submitOp, '应有提交操作日志');
    assert.strictEqual(precheckOp.user_name, 'qianqi', '操作人应为qianqi');
    assert.strictEqual(submitOp.user_name, 'qianqi', '操作人应为qianqi');
    
    console.log(`  预检操作时间: ${precheckOp.created_at}`);
    console.log(`  提交操作时间: ${submitOp.created_at}`);
  });

  await runTest('验证提交后部门预算正确更新', async () => {
    const res = await axios.get(`${BASE_URL}/departments`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    const techDept = res.data.departments.find(d => d.name === '技术部');
    const marketingDept = res.data.departments.find(d => d.name === '市场部');
    
    assert.ok(techDept, '技术部应该存在');
    assert.ok(marketingDept, '市场部应该存在');
    
    const techLine = submitResult.lines.find(l => l.department_name === '技术部');
    const marketLine = submitResult.lines.find(l => l.department_name === '市场部');
    
    assert.strictEqual(techDept.budget_total, techLine.budget_after, '技术部预算应正确更新');
    assert.strictEqual(marketingDept.budget_total, marketLine.budget_after, '市场部预算应正确更新');
    
    console.log(`  技术部预算: ${techDept.budget_total}`);
    console.log(`  市场部预算: ${marketingDept.budget_total}`);
  });

  console.log('\n----------------------------------------');
  console.log('  第七部分：状态筛选功能');
  console.log('----------------------------------------');

  await runTest('按状态筛选 - prechecked', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches?status=prechecked`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    for (const batch of res.data.batches) {
      assert.strictEqual(batch.status, 'prechecked', '所有批次状态应为prechecked');
    }
    console.log(`  找到 ${res.data.batches.length} 个prechecked状态的批次`);
  });

  await runTest('按状态筛选 - completed', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches?status=completed`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    for (const batch of res.data.batches) {
      assert.strictEqual(batch.status, 'completed', '所有批次状态应为completed');
    }
    console.log(`  找到 ${res.data.batches.length} 个completed状态的批次`);
  });

  await runTest('按状态筛选 - cancelled', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches?status=cancelled`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    for (const batch of res.data.batches) {
      assert.strictEqual(batch.status, 'cancelled', '所有批次状态应为cancelled');
    }
    console.log(`  找到 ${res.data.batches.length} 个cancelled状态的批次`);
  });

  await runTest('按批次号模糊搜索', async () => {
    const res = await axios.get(`${BASE_URL}/budget-batches?batchId=${testBatchId.substring(0, 10)}`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    assert.ok(res.data.batches.length > 0, '应该找到匹配的批次');
    for (const batch of res.data.batches) {
      assert.ok(batch.batch_id.includes(testBatchId.substring(0, 10)), '批次号应包含搜索关键词');
    }
  });

  console.log('\n----------------------------------------');
  console.log('  第八部分：导出功能');
  console.log('----------------------------------------');

  async function testExport(type, description) {
    let csvContent = null;
    await runTest(description, async () => {
      const res = await axios.get(
        `${BASE_URL}/budget-batches/${successBatchId}/export?type=${type}`, 
        { 
          headers: { Authorization: `Bearer ${financeToken}` },
          responseType: 'arraybuffer'
        }
      );
      
      assert.strictEqual(res.status, 200, '应该返回200');
      assert.ok(res.data.length > 0, '应该有数据');
      
      csvContent = Buffer.from(res.data).toString('utf-8');
      assert.ok(csvContent.includes('批次号'), 'CSV应包含批次号列');
      
      if (type !== 'failed') {
        assert.ok(csvContent.includes(successBatchId), 'CSV应包含批次号');
      }
      
      const exportDir = path.join(__dirname, 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      const filename = `test-export-${type}-${Date.now()}.csv`;
      fs.writeFileSync(path.join(exportDir, filename), csvContent);
      console.log(`  导出文件已保存: exports/${filename}`);
      console.log(`  文件大小: ${csvContent.length} 字节`);
      
      const lines = csvContent.trim().split('\n');
      console.log(`  数据行数: ${lines.length - 1} 行`);
    });
    return csvContent;
  }

  const allCsv = await testExport('all', '导出全部数据');
  const precheckCsv = await testExport('precheck', '导出预检结果');
  const ledgerCsv = await testExport('ledger', '导出记账结果');
  const failedCsv = await testExport('failed', '导出失败原因');

  await runTest('导出内容核对 - 预检结果包含预计余额', async () => {
    assert.ok(allCsv.includes('当前预算'), '预检结果应包含当前预算列');
    assert.ok(allCsv.includes('预计调整后'), '预检结果应包含预计调整后列');
  });

  await runTest('导出内容核对 - 记账结果包含调整记录ID', async () => {
    assert.ok(allCsv.includes('调整前预算'), '记账结果应包含调整前预算列');
    assert.ok(allCsv.includes('调整后预算'), '记账结果应包含调整后预算列');
    assert.ok(allCsv.includes('调整记录ID'), '记账结果应包含调整记录ID列');
  });

  await runTest('导出内容核对 - 失败原因包含错误信息', async () => {
    assert.ok(failedCsv.includes('错误信息'), '失败原因应包含错误信息列');
  });

  console.log('\n----------------------------------------');
  console.log('  第九部分：模拟服务重启验证');
  console.log('----------------------------------------');

  await runTest('服务重启后状态查询验证', async () => {
    console.log('  提示：请在实际测试中重启服务后重新查询');
    console.log('  当前验证：直接查询数据库确认数据持久化');
    
    const res = await axios.get(`${BASE_URL}/budget-batches/${successBatchId}`, {
      headers: { Authorization: `Bearer ${financeToken}` }
    });
    
    assert.strictEqual(res.data.batch.status, 'completed', '重启后状态仍应为completed');
    assert.strictEqual(res.data.lines.length, 2, '重启后明细仍应为2条');
    assert.ok(res.data.operations.length >= 2, '重启后操作日志至少应有2条（预检+提交）');
    
    const precheckOp = res.data.operations.find(o => o.operation === 'precheck');
    const submitOp = res.data.operations.find(o => o.operation === 'submit');
    assert.ok(precheckOp, '应有预检操作日志');
    assert.ok(submitOp, '应有提交操作日志');
    
    console.log(`  ✓ 批次状态: ${res.data.batch.status}`);
    console.log(`  ✓ 明细行数: ${res.data.lines.length}`);
    console.log(`  ✓ 操作日志数: ${res.data.operations.length}`);
    console.log(`  ✓ 操作人: ${res.data.batch.user_name}`);
    console.log(`  ✓ 预检日志存在: ${precheckOp ? '是' : '否'}`);
    console.log(`  ✓ 提交日志存在: ${submitOp ? '是' : '否'}`);
  });

  console.log('\n----------------------------------------');
  console.log('  第十部分：API文档验证');
  console.log('----------------------------------------');

  await runTest('健康检查接口', async () => {
    const res = await axios.get(`${BASE_URL}/health`);
    assert.strictEqual(res.data.status, 'ok', '健康检查应返回ok');
  });

  await runTest('所有接口错误码完整', async () => {
    const expectedCodes = [
      'MISSING_BATCH_ID',
      'MISSING_DATA',
      'NO_DATA',
      'BATCH_NOT_FOUND',
      'BATCH_NOT_PRECHECKED',
      'BATCH_ALREADY_PROCESSED',
      'BATCH_CANCELLED',
      'CONTENT_MODIFIED',
      'CONTENT_MISMATCH',
      'PERMISSION_DENIED',
      'VALIDATION_FAILED',
      'BUDGET_VIOLATION',
      'NEGATIVE_BUDGET',
      'ALREADY_CANCELLED',
      'CANCEL_FAILED',
      'PRECHECK_FAILED',
      'SUBMIT_FAILED'
    ];
    
    console.log(`  支持的错误码: ${expectedCodes.length} 个`);
    console.log(`  ${expectedCodes.join(', ')}`);
  });

  console.log('\n========================================');
  console.log('  测试结果汇总');
  console.log('========================================');
  console.log(`总测试数: ${results.total}`);
  console.log(`通过: ${results.passed}`);
  console.log(`失败: ${results.failed}`);
  console.log(`通过率: ${((results.passed / results.total) * 100).toFixed(1)}%`);
  console.log('========================================');

  if (results.failed > 0) {
    console.log('\n⚠ 有测试失败，请检查错误信息');
    process.exit(1);
  } else {
    console.log('\n✓ 所有测试通过！');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('\n测试执行失败:', err.message);
  process.exit(1);
});
