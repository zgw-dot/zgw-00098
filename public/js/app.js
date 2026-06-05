const API_BASE = '/api';
let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');

const statusMap = {
  'pending': { text: '待审批', class: 'status-pending' },
  'approved': { text: '主管已批', class: 'status-approved' },
  'rejected': { text: '已驳回', class: 'status-rejected' },
  'withdrawn': { text: '已撤回', class: 'status-withdrawn' },
  'confirmed': { text: '财务确认', class: 'status-confirmed' }
};

const actionMap = {
  'submit': '提交申请',
  'approve': '主管审批',
  'reject': '驳回申请',
  'withdraw': '撤回申请',
  'confirm': '财务确认'
};

const adjustmentTypeMap = {
  'increase': { text: '追加预算', class: 'status-approved' },
  'decrease': { text: '调减预算', class: 'status-rejected' }
};

async function apiRequest(url, method = 'GET', body = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(API_BASE + url, options);
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || '请求失败');
    }
    
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

function showModal(title, content) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = content;
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

function formatCurrency(amount) {
  return parseFloat(amount).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function renderUserInfo() {
  if (!currentUser) return;
  
  const roleMap = {
    'applicant': '申请人',
    'supervisor': '主管',
    'finance': '财务'
  };
  
  const deptText = currentUser.department ? ` (${currentUser.department})` : '';
  
  document.getElementById('userInfo').innerHTML = `
    <span>${currentUser.username} - ${roleMap[currentUser.role]}${deptText}</span>
    <button id="logoutBtn">退出</button>
  `;
  
  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    token = null;
    currentUser = null;
    showLoginView();
  };

  if (currentUser.role !== 'finance') {
    document.getElementById('exportTab').style.display = 'none';
  } else {
    document.getElementById('exportTab').style.display = 'inline-block';
  }

  if (currentUser.role !== 'applicant') {
    document.getElementById('newApplicationBtn').style.display = 'none';
  } else {
    document.getElementById('newApplicationBtn').style.display = 'inline-block';
  }

  if (currentUser.role !== 'finance') {
    document.getElementById('budgetAdjustmentsTab').style.display = 'none';
    document.getElementById('newAdjustmentBtn').style.display = 'none';
  } else {
    document.getElementById('budgetAdjustmentsTab').style.display = 'inline-block';
    document.getElementById('newAdjustmentBtn').style.display = 'inline-block';
  }
}

function showLoginView() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('mainView').classList.add('hidden');
  document.getElementById('userInfo').innerHTML = '';
}

function showMainView() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('mainView').classList.remove('hidden');
  renderUserInfo();
  loadApplications();
  loadDepartments();
  if (currentUser.role === 'finance') {
    loadAdjustments();
    loadDeptFilter();
  }
}

async function loadApplications(status = '') {
  try {
    const url = status ? `/applications?status=${status}` : '/applications';
    const data = await apiRequest(url);
    renderApplications(data.applications);
  } catch (err) {
    console.error('加载申请失败:', err);
  }
}

function renderApplications(applications) {
  const container = document.getElementById('applicationsList');
  
  if (applications.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无申请记录</div>';
    return;
  }

  const canSeeActions = (app) => {
    if (currentUser.role === 'applicant') {
      return app.applicant_id === currentUser.id && app.status === 'pending';
    }
    if (currentUser.role === 'supervisor') {
      return app.department_name === currentUser.department && 
             app.status === 'pending' &&
             app.applicant_id !== currentUser.id;
    }
    if (currentUser.role === 'finance') {
      return app.status === 'approved';
    }
    return false;
  };

  let html = `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>部门</th>
          <th>申请人</th>
          <th>金额</th>
          <th>供应商</th>
          <th>用途</th>
          <th>状态</th>
          <th>创建时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const app of applications) {
    const status = statusMap[app.status] || { text: app.status, class: '' };
    const showActions = canSeeActions(app);
    
    html += `
      <tr>
        <td>${app.id}</td>
        <td>${app.department_name}</td>
        <td>${app.applicant_name}</td>
        <td>¥${formatCurrency(app.amount)}</td>
        <td>${app.supplier}</td>
        <td>${app.purpose}</td>
        <td><span class="status-badge ${status.class}">${status.text}</span></td>
        <td>${new Date(app.created_at).toLocaleString('zh-CN')}</td>
        <td>
          <button class="btn btn-info" onclick="viewApplication(${app.id})">详情</button>
          ${showActions ? renderActionButtons(app) : ''}
        </td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderActionButtons(app) {
  let buttons = '';
  
  if (currentUser.role === 'applicant') {
    buttons += `<button class="btn btn-warning" onclick="withdrawApplication(${app.id})">撤回</button>`;
  } else if (currentUser.role === 'supervisor') {
    buttons += `
      <button class="btn btn-success" onclick="approveApplication(${app.id})">通过</button>
      <button class="btn btn-danger" onclick="rejectApplication(${app.id})">驳回</button>
    `;
  } else if (currentUser.role === 'finance') {
    buttons += `<button class="btn btn-success" onclick="confirmApplication(${app.id})">确认</button>`;
  }
  
  return `<span class="actions">${buttons}</span>`;
}

async function viewApplication(id) {
  try {
    const data = await apiRequest(`/applications/${id}`);
    const app = data.application;
    const timeline = data.timeline;
    const status = statusMap[app.status] || { text: app.status, class: '' };

    let html = `
      <div class="detail-row">
        <span class="detail-label">申请编号</span>
        <span class="detail-value">${app.id}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">部门</span>
        <span class="detail-value">${app.department_name}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">申请人</span>
        <span class="detail-value">${app.applicant_name}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">金额</span>
        <span class="detail-value">¥${formatCurrency(app.amount)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">供应商</span>
        <span class="detail-value">${app.supplier}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">用途</span>
        <span class="detail-value">${app.purpose}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">状态</span>
        <span class="detail-value"><span class="status-badge ${status.class}">${status.text}</span></span>
      </div>
      ${currentUser.role === 'applicant' && app.applicant_id === currentUser.id && app.status === 'approved' ? `
      <div class="detail-row">
        <span class="detail-label"></span>
        <span class="detail-value" style="color: #d69e2e; font-size: 0.9rem;">
          ⚠ 已审批通过的申请不能撤回，如需修改请联系财务处理
        </span>
      </div>` : ''}
      ${app.supervisor_name ? `
      <div class="detail-row">
        <span class="detail-label">审批主管</span>
        <span class="detail-value">${app.supervisor_name}</span>
      </div>` : ''}
      ${app.finance_name ? `
      <div class="detail-row">
        <span class="detail-label">财务确认</span>
        <span class="detail-value">${app.finance_name}</span>
      </div>` : ''}
      <div class="detail-row">
        <span class="detail-label">创建时间</span>
        <span class="detail-value">${new Date(app.created_at).toLocaleString('zh-CN')}</span>
      </div>
    `;

    if (timeline.length > 0) {
      html += '<div class="timeline"><h4>审批时间线</h4>';
      for (const item of timeline) {
        html += `
          <div class="timeline-item">
            <div>
              <div class="timeline-action">${actionMap[item.action] || item.action}</div>
              <div class="timeline-user">操作人: ${item.user_name}</div>
              <div class="timeline-time">${new Date(item.created_at).toLocaleString('zh-CN')}</div>
              ${item.remark ? `<div class="timeline-remark">${item.remark}</div>` : ''}
            </div>
          </div>
        `;
      }
      html += '</div>';
    }

    showModal(`申请详情 #${app.id}`, html);
  } catch (err) {
    console.error('加载详情失败:', err);
  }
}

function showNewApplicationForm() {
  const html = `
    <form id="applicationForm">
      <div class="form-group">
        <label>金额</label>
        <input type="number" id="appAmount" step="0.01" min="0" required placeholder="请输入金额">
      </div>
      <div class="form-group">
        <label>供应商</label>
        <input type="text" id="appSupplier" required placeholder="请输入供应商名称">
      </div>
      <div class="form-group">
        <label>用途</label>
        <textarea id="appPurpose" rows="3" required placeholder="请输入采购用途"></textarea>
      </div>
      <div style="text-align: right; margin-top: 1rem;">
        <button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary">提交申请</button>
      </div>
    </form>
  `;

  showModal('新建采购申请', html);

  document.getElementById('applicationForm').onsubmit = async (e) => {
    e.preventDefault();
    
    const amount = parseFloat(document.getElementById('appAmount').value);
    const supplier = document.getElementById('appSupplier').value.trim();
    const purpose = document.getElementById('appPurpose').value.trim();

    try {
      await apiRequest('/applications', 'POST', { amount, supplier, purpose });
      showToast('申请提交成功', 'success');
      closeModal();
      loadApplications();
      loadDepartments();
    } catch (err) {
      console.error('提交失败:', err);
    }
  };
}

async function withdrawApplication(id) {
  if (!confirm('确定要撤回此申请吗？')) return;

  try {
    await apiRequest(`/applications/${id}/withdraw`, 'POST', {});
    showToast('申请已撤回', 'success');
    loadApplications();
    loadDepartments();
  } catch (err) {
    console.error('撤回失败:', err);
  }
}

async function approveApplication(id) {
  if (!confirm('确定要通过此申请吗？')) return;

  try {
    await apiRequest(`/applications/${id}/approve`, 'POST', {});
    showToast('审批通过', 'success');
    loadApplications();
  } catch (err) {
    console.error('审批失败:', err);
  }
}

async function rejectApplication(id) {
  const remark = prompt('请输入驳回原因：');
  if (remark === null) return;

  try {
    await apiRequest(`/applications/${id}/reject`, 'POST', { remark });
    showToast('申请已驳回', 'success');
    loadApplications();
    loadDepartments();
  } catch (err) {
    console.error('驳回失败:', err);
  }
}

async function confirmApplication(id) {
  if (!confirm('确定要进行财务确认吗？确认后预算将正式占用。')) return;

  try {
    await apiRequest(`/applications/${id}/confirm`, 'POST', {});
    showToast('财务确认成功', 'success');
    loadApplications();
    loadDepartments();
  } catch (err) {
    console.error('确认失败:', err);
  }
}

async function loadDepartments() {
  try {
    const data = await apiRequest('/departments');
    renderDepartments(data.departments);
  } catch (err) {
    console.error('加载部门预算失败:', err);
  }
}

function renderDepartments(departments) {
  const container = document.getElementById('budgetList');

  let html = `
    <table>
      <thead>
        <tr>
          <th>部门</th>
          <th>总预算</th>
          <th>已使用</th>
          <th>锁定中</th>
          <th>可用余额</th>
          <th>调整次数</th>
          ${currentUser.role === 'finance' ? '<th>操作</th>' : ''}
        </tr>
      </thead>
      <tbody>
  `;

  for (const dept of departments) {
    html += `
      <tr>
        <td>${dept.name}</td>
        <td>¥${formatCurrency(dept.budget_total)}</td>
        <td>¥${formatCurrency(dept.budget_used)}</td>
        <td>¥${formatCurrency(dept.budget_locked)}</td>
        <td><strong>¥${formatCurrency(dept.budget_available)}</strong></td>
        <td>${dept.adjustment_count || 0}</td>
        ${currentUser.role === 'finance' ? `<td><button class="btn btn-info" onclick="showAdjustmentForm(${dept.id}, '${dept.name}')">调整预算</button></td>` : ''}
      </tr>
    `;
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadDeptFilter() {
  try {
    const data = await apiRequest('/departments');
    const select = document.getElementById('deptFilter');
    select.innerHTML = '<option value="">全部部门</option>';
    for (const dept of data.departments) {
      select.innerHTML += `<option value="${dept.id}">${dept.name}</option>`;
    }
  } catch (err) {
    console.error('加载部门列表失败:', err);
  }
}

async function loadAdjustments(departmentId = '') {
  try {
    const url = departmentId ? `/budget-adjustments?departmentId=${departmentId}` : '/budget-adjustments';
    const data = await apiRequest(url);
    renderAdjustments(data.adjustments);
  } catch (err) {
    console.error('加载调整记录失败:', err);
  }
}

function renderAdjustments(adjustments) {
  const container = document.getElementById('adjustmentsList');

  if (adjustments.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无预算调整记录</div>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>部门</th>
          <th>类型</th>
          <th>调整金额</th>
          <th>调整前</th>
          <th>调整后</th>
          <th>操作人</th>
          <th>原因</th>
          <th>时间</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const adj of adjustments) {
    const typeInfo = adjustmentTypeMap[adj.adjustment_type] || { text: adj.adjustment_type, class: '' };
    const amountDisplay = adj.adjustment_type === 'increase'
      ? `+¥${formatCurrency(adj.amount)}`
      : `-¥${formatCurrency(adj.amount)}`;

    html += `
      <tr>
        <td>${adj.id}</td>
        <td>${adj.department_name}</td>
        <td><span class="status-badge ${typeInfo.class}">${typeInfo.text}</span></td>
        <td>${amountDisplay}</td>
        <td>¥${formatCurrency(adj.budget_before)}</td>
        <td>¥${formatCurrency(adj.budget_after)}</td>
        <td>${adj.user_name}</td>
        <td>${adj.reason}</td>
        <td>${new Date(adj.created_at).toLocaleString('zh-CN')}</td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function showAdjustmentForm(departmentId, departmentName) {
  const html = `
    <form id="adjustmentForm">
      <div class="form-group">
        <label>部门</label>
        <input type="text" id="adjDeptName" value="${departmentName}" disabled>
      </div>
      <div class="form-group">
        <label>调整类型</label>
        <select id="adjType" required>
          <option value="increase">追加预算</option>
          <option value="decrease">调减预算</option>
        </select>
      </div>
      <div class="form-group">
        <label>调整金额</label>
        <input type="number" id="adjAmount" step="0.01" min="0.01" required placeholder="请输入调整金额">
      </div>
      <div class="form-group">
        <label>调整原因</label>
        <textarea id="adjReason" rows="3" required placeholder="请详细说明调整原因"></textarea>
      </div>
      <div style="text-align: right; margin-top: 1rem;">
        <button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary">确认调整</button>
      </div>
    </form>
  `;

  showModal(`调整 ${departmentName} 预算`, html);

  document.getElementById('adjustmentForm').onsubmit = async (e) => {
    e.preventDefault();

    const adjustmentType = document.getElementById('adjType').value;
    const amount = parseFloat(document.getElementById('adjAmount').value);
    const reason = document.getElementById('adjReason').value.trim();

    try {
      await apiRequest('/budget-adjustments', 'POST', {
        departmentId,
        adjustmentType,
        amount,
        reason
      });
      showToast('预算调整成功', 'success');
      closeModal();
      loadDepartments();
      loadAdjustments(document.getElementById('deptFilter').value);
    } catch (err) {
      console.error('调整失败:', err);
    }
  };
}

function showNewAdjustmentForm() {
  const html = `
    <form id="adjustmentForm">
      <div class="form-group">
        <label>部门</label>
        <select id="adjDeptId" required></select>
      </div>
      <div class="form-group">
        <label>调整类型</label>
        <select id="adjType" required>
          <option value="increase">追加预算</option>
          <option value="decrease">调减预算</option>
        </select>
      </div>
      <div class="form-group">
        <label>调整金额</label>
        <input type="number" id="adjAmount" step="0.01" min="0.01" required placeholder="请输入调整金额">
      </div>
      <div class="form-group">
        <label>调整原因</label>
        <textarea id="adjReason" rows="3" required placeholder="请详细说明调整原因"></textarea>
      </div>
      <div style="text-align: right; margin-top: 1rem;">
        <button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary">确认调整</button>
      </div>
    </form>
  `;

  showModal('调整部门预算', html);

  apiRequest('/departments').then(data => {
    const select = document.getElementById('adjDeptId');
    select.innerHTML = '<option value="">请选择部门</option>';
    for (const dept of data.departments) {
      select.innerHTML += `<option value="${dept.id}">${dept.name}</option>`;
    }
  });

  document.getElementById('adjustmentForm').onsubmit = async (e) => {
    e.preventDefault();

    const departmentId = parseInt(document.getElementById('adjDeptId').value);
    const adjustmentType = document.getElementById('adjType').value;
    const amount = parseFloat(document.getElementById('adjAmount').value);
    const reason = document.getElementById('adjReason').value.trim();

    if (!departmentId) {
      showToast('请选择部门', 'error');
      return;
    }

    try {
      await apiRequest('/budget-adjustments', 'POST', {
        departmentId,
        adjustmentType,
        amount,
        reason
      });
      showToast('预算调整成功', 'success');
      closeModal();
      loadDepartments();
      loadAdjustments(document.getElementById('deptFilter').value);
    } catch (err) {
      console.error('调整失败:', err);
    }
  };
}

async function checkConsistency() {
  try {
    const result = await apiRequest('/ledger/check');
    renderConsistencyResult(result);
  } catch (err) {
    console.error('一致性检查失败:', err);
  }
}

function renderConsistencyResult(result) {
  const container = document.getElementById('consistencyResult');
  
  const statusClass = result.overallConsistent ? 'success' : 'error';
  const statusText = result.overallConsistent ? '✓ 数据一致性检查通过' : '✗ 发现数据不一致';

  let html = `
    <div class="consistency-summary ${statusClass}">
      <strong>${statusText}</strong>
      <div style="font-size: 0.85rem; margin-top: 0.5rem;">
        检查时间: ${new Date(result.timestamp).toLocaleString('zh-CN')}
      </div>
    </div>
  `;

  if (result.inconsistencies.length > 0) {
    html += `
      <div class="consistency-section">
        <h4>不一致项 (${result.inconsistencies.length})</h4>
        <ul class="inconsistency-list">
          ${result.inconsistencies.map(i => `<li>${i.message}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  html += `
    <div class="consistency-section">
      <h4>汇总信息</h4>
      <div class="detail-row">
        <span class="detail-label">总预算</span>
        <span class="detail-value">¥${formatCurrency(result.summary.total_budget)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">已使用</span>
        <span class="detail-value">¥${formatCurrency(result.summary.total_used)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">锁定中</span>
        <span class="detail-value">¥${formatCurrency(result.summary.total_locked)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">总可用</span>
        <span class="detail-value">¥${formatCurrency(result.summary.total_available)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">申请总数</span>
        <span class="detail-value">${result.summary.application_count}</span>
      </div>
      ${result.summary.budget_adjustment_count > 0 ? `
      <div class="detail-row">
        <span class="detail-label">预算调整次数</span>
        <span class="detail-value">${result.summary.budget_adjustment_count}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">累计追加</span>
        <span class="detail-value" style="color: #2b6cb0;">+¥${formatCurrency(result.summary.total_adjustments_increase)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">累计调减</span>
        <span class="detail-value" style="color: #c53030;">-¥${formatCurrency(result.summary.total_adjustments_decrease)}</span>
      </div>
      ` : ''}
    </div>
  `;

  html += `
    <div class="consistency-section">
      <h4>部门预算明细</h4>
      <div class="consistency-grid">
        ${result.departments.map(d => `
          <div class="consistency-card ${d.used_consistent && d.locked_consistent && d.budget_total_consistent ? 'success' : 'error'}">
            <strong>${d.name}</strong>
            <div style="font-size: 0.85rem; margin-top: 0.5rem;">
              总预算: ¥${formatCurrency(d.budget_total)} 
              ${d.budget_total_consistent !== undefined ? (d.budget_total_consistent ? '✓' : '✗ (计算值 ' + formatCurrency(d.calculated_budget_total) + ')') : ''}<br>
              已使用: ¥${formatCurrency(d.budget_used)} 
              ${d.used_consistent ? '✓' : '✗ (应为 ' + formatCurrency(d.expected_used) + ')'}<br>
              锁定中: ¥${formatCurrency(d.budget_locked)} 
              ${d.locked_consistent ? '✓' : '✗ (应为 ' + formatCurrency(d.expected_locked) + ')'}<br>
              可用: ¥${formatCurrency(d.budget_available)}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  if (result.budgetAdjustments && result.budgetAdjustments.length > 0) {
    html += `
      <div class="consistency-section">
        <h4>预算调整明细 (${result.budgetAdjustments.length})</h4>
        <div class="consistency-grid">
          ${result.budgetAdjustments.map(a => `
            <div class="consistency-card ${a.amount_consistent ? 'success' : 'error'}">
              <strong>${a.department} - ${adjustmentTypeMap[a.adjustment_type]?.text || a.adjustment_type}</strong>
              <div style="font-size: 0.85rem; margin-top: 0.5rem;">
                金额: ${a.adjustment_type === 'increase' ? '+' : '-'}¥${formatCurrency(a.amount)}<br>
                调整前: ¥${formatCurrency(a.budget_before)}<br>
                调整后: ¥${formatCurrency(a.budget_after)} 
                ${a.amount_consistent ? '✓' : '✗ (应为 ' + formatCurrency(a.expected_after) + ')'}<br>
                操作人: ${a.user_name}<br>
                原因: ${a.reason}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  html += `
    <div class="consistency-section">
      <h4>申请状态明细</h4>
      <div class="consistency-grid">
        ${result.applications.map(a => `
          <div class="consistency-card ${a.status_consistent ? 'success' : 'error'}">
            <strong>申请 #${a.id}</strong>
            <div style="font-size: 0.85rem; margin-top: 0.5rem;">
              金额: ¥${formatCurrency(a.amount)}<br>
              状态: ${a.status} ${a.status_consistent ? '✓' : '✗ (应为 ' + a.expected_status + ')'}<br>
              时间线: ${a.timeline_count} 条
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

async function exportLedger() {
  try {
    const res = await fetch(API_BASE + '/ledger/export', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '导出失败');
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `budget-ledger-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showToast('账本导出成功', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const data = await apiRequest('/auth/login', 'POST', { username, password });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    showToast('登录成功', 'success');
    showMainView();
  } catch (err) {
    console.error('登录失败:', err);
  }
};

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    const tab = btn.dataset.tab;
    
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    btn.classList.add('active');
    document.getElementById(tab + 'Tab').classList.add('active');
    
    if (tab === 'applications') loadApplications();
    if (tab === 'budget') loadDepartments();
    if (tab === 'budgetAdjustments' && currentUser.role === 'finance') {
      loadAdjustments(document.getElementById('deptFilter').value);
    }
  };
});

document.getElementById('newApplicationBtn').onclick = showNewApplicationForm;
document.getElementById('refreshBtn').onclick = () => loadApplications(document.getElementById('statusFilter').value);
document.getElementById('statusFilter').onchange = (e) => loadApplications(e.target.value);
document.getElementById('checkConsistencyBtn').onclick = checkConsistency;
document.getElementById('exportLedgerBtn').onclick = exportLedger;
document.getElementById('newAdjustmentBtn').onclick = showNewAdjustmentForm;
document.getElementById('refreshAdjBtn').onclick = () => loadAdjustments(document.getElementById('deptFilter').value);
document.getElementById('deptFilter').onchange = (e) => loadAdjustments(e.target.value);
document.querySelector('.close').onclick = closeModal;

document.getElementById('modal').onclick = (e) => {
  if (e.target.id === 'modal') closeModal();
};

window.viewApplication = viewApplication;
window.withdrawApplication = withdrawApplication;
window.approveApplication = approveApplication;
window.rejectApplication = rejectApplication;
window.confirmApplication = confirmApplication;
window.closeModal = closeModal;
window.showAdjustmentForm = showAdjustmentForm;

if (token && currentUser) {
  apiRequest('/auth/me').then(() => {
    showMainView();
  }).catch(() => {
    showLoginView();
  });
} else {
  showLoginView();
}
