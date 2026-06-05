# 采购预算审批服务

本地采购预算审批服务，用于替代邮件里的采购申请和预算占用记录。

## 技术栈

- **后端**: Node.js + Express + SQLite
- **前端**: 原生 HTML/CSS/JavaScript
- **认证**: JWT Token
- **权限**: 基于角色的后端权限校验（不仅仅是前端按钮隐藏）

## 项目结构

```
.
├── config/
│   ├── config.js          # 配置文件（JWT密钥、端口）
│   └── database.js        # 数据库连接
├── middleware/
│   └── auth.js            # 认证和权限中间件
├── routes/
│   ├── auth.js            # 登录认证接口
│   ├── applications.js    # 申请相关接口（核心业务逻辑）
│   ├── departments.js     # 部门预算接口
│   ├── ledger.js          # 一致性检查和CSV导出
│   ├── budget-adjustments.js  # 预算调整接口
│   └── budget-batches.js  # 批量预算调整接口
├── scripts/
│   └── init-db.js         # 数据库初始化脚本
├── public/                # 前端静态文件
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── data/                  # SQLite 数据库文件目录（运行时创建）
├── exports/               # CSV 导出目录（运行时创建）
├── server.js              # 服务入口
└── package.json
```

## 数据库表设计

### users（用户表）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| username | TEXT | 用户名（唯一） |
| password_hash | TEXT | 密码哈希 |
| role | TEXT | 角色: applicant/supervisor/finance |
| department | TEXT | 所属部门 |

### departments（部门预算表）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| name | TEXT | 部门名称（唯一） |
| budget_total | DECIMAL | 总预算 |
| budget_used | DECIMAL | 已使用预算（财务确认后） |
| budget_locked | DECIMAL | 锁定中预算（审批中） |
| budget_available | DECIMAL | 可用余额（计算字段） |

### applications（采购申请表）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| applicant_id | INTEGER | 申请人ID |
| department_id | INTEGER | 部门ID |
| amount | DECIMAL | 申请金额 |
| supplier | TEXT | 供应商 |
| purpose | TEXT | 用途 |
| status | TEXT | 状态: pending/approved/rejected/withdrawn/confirmed |
| supervisor_id | INTEGER | 审批主管ID |
| finance_id | INTEGER | 财务确认人ID |

### timeline（审批时间线）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| application_id | INTEGER | 申请ID |
| user_id | INTEGER | 操作人ID |
| action | TEXT | 动作: submit/approve/reject/withdraw/confirm |
| remark | TEXT | 备注 |
| created_at | DATETIME | 操作时间 |

### budget_adjustments（预算调整表）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| department_id | INTEGER | 部门ID |
| user_id | INTEGER | 操作人ID |
| adjustment_type | TEXT | 类型: increase/decrease/reversal |
| amount | DECIMAL | 调整金额 |
| budget_before | DECIMAL | 调整前预算 |
| budget_after | DECIMAL | 调整后预算 |
| reason | TEXT | 调整原因 |
| batch_id | TEXT | 关联批次号（批量调整时） |
| batch_line | INTEGER | 批次内行号（批量调整时） |
| created_at | DATETIME | 创建时间 |

### budget_batches（批量调整批次表）
| 字段 | 类型 | 说明 |
|------|------|------|
| batch_id | TEXT | 主键，批次号 |
| user_id | INTEGER | 操作人ID |
| status | TEXT | 状态: pending/prechecked/submitted/failed/completed |
| total_rows | INTEGER | 总行数 |
| success_rows | INTEGER | 成功行数 |
| failed_rows | INTEGER | 失败行数 |
| total_amount | DECIMAL | 总调整金额 |
| error_message | TEXT | 错误信息 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### budget_batch_lines（批量调整行表）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| batch_id | TEXT | 批次号（外键） |
| line_number | INTEGER | 行号 |
| department_id | INTEGER | 部门ID |
| department_name | TEXT | 部门名称 |
| adjustment_type | TEXT | 类型: increase/decrease |
| amount | DECIMAL | 调整金额 |
| reason | TEXT | 调整原因 |
| status | TEXT | 状态: pending/valid/invalid/submitted/failed |
| validation_error | TEXT | 校验错误信息 |
| budget_before | DECIMAL | 调整前预算 |
| budget_after | DECIMAL | 调整后预算 |
| adjustment_id | INTEGER | 关联调整记录ID |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

## 业务流程

```
申请人提交申请 → 锁定部门预算 → 主管审批
     ↓                    ↓
财务确认 ← 主管通过    主管驳回 → 释放预算
     ↓
预算正式占用（从锁定转为已使用）
```

状态流转:
- **pending** (待审批) → 申请人提交后
- **approved** (主管已批) → 主管审批通过后
- **rejected** (已驳回) → 主管驳回后（终态）
- **withdrawn** (已撤回) → 申请人撤回后（终态）
- **confirmed** (财务确认) → 财务确认后（终态）

撤回规则:
- 仅 **pending** 状态可由申请人撤回
- **approved**、**withdrawn**、**confirmed**、**rejected** 状态均不可撤回
- 撤回后预算锁定自动释放，状态变更为 withdrawn（终态）

## 快速开始

### 1. 初始化数据库

```bash
npm run init
```

初始化后会创建以下测试账号（密码均为 `123456`）：

| 用户名 | 角色 | 部门 | 说明 |
|--------|------|------|------|
| zhangsan | 申请人 | 技术部 | 可提交技术部采购申请 |
| lisi | 申请人 | 市场部 | 可提交市场部采购申请 |
| wangwu | 主管 | 技术部 | 可审批技术部申请 |
| zhaoliu | 主管 | 市场部 | 可审批市场部申请 |
| qianqi | 财务 | - | 可进行财务确认、导出账本 |

初始部门预算：
- 技术部: ¥100,000.00
- 市场部: ¥80,000.00
- 财务部: ¥50,000.00

### 2. 启动服务

```bash
npm start
```

服务启动后访问: http://localhost:3000

## 角色模拟方式

本系统权限控制在**后端 API 层面**实现，前端按钮隐藏仅为体验优化。即使通过开发者工具修改前端或直接调用 API，后端仍会校验权限。

### 模拟不同角色

**方式一：使用管理页面（推荐）**

在浏览器中使用不同账号登录即可：
- 申请人：zhangsan / 123456
- 主管：wangwu / 123456
- 财务：qianqi / 123456

**方式二：直接调用 API（用于测试权限校验）**

```bash
# 1. 登录获取 Token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"zhangsan","password":"123456"}' | jq -r .token)

# 2. 使用 Token 调用接口
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/applications
```

### 权限矩阵

| 操作 | 申请人 | 主管 | 财务 | 说明 |
|------|--------|------|------|------|
| 提交申请 | ✅ | ❌ | ❌ | 只能提交本部门申请 |
| 查看申请列表 | ✅（仅自己的） | ✅（仅本部门的） | ✅（全部） | |
| 主管审批 | ❌ | ✅ | ❌ | 只能审批本部门、非自己提交的 |
| 驳回申请 | ❌ | ✅ | ❌ | 只能驳回本部门、非自己提交的 |
| 撤回申请 | ✅（仅自己的） | ❌ | ❌ | 只能撤回 pending 状态的，approved/withdrawn/confirmed/rejected 均不可撤回 |
| 财务确认 | ❌ | ❌ | ✅ | 只能确认 approved 状态的 |
| 导出CSV账本 | ❌ | ❌ | ✅ | |
| 一致性检查 | ✅ | ✅ | ✅ | 所有登录用户 |
| 预算调整（单笔） | ❌ | ❌ | ✅ | 财务追加/调减预算 |
| 批量调整预检 | ❌ | ❌ | ✅ | 财务预检批量调整 |
| 批量调整提交 | ❌ | ❌ | ✅ | 财务提交批量调整（事务处理） |
| 查看批次列表 | ✅ | ✅ | ✅ | 所有登录用户 |
| 查看批次详情 | ✅ | ✅ | ✅ | 所有登录用户 |
| 导出批次CSV | ❌ | ❌ | ✅ | 财务导出批次结果 |

## API 接口文档

### 认证接口

```bash
# 登录
POST /api/auth/login
Content-Type: application/json

{
  "username": "zhangsan",
  "password": "123456"
}

# 获取当前用户信息
GET /api/auth/me
Authorization: Bearer <token>
```

### 申请接口

```bash
# 获取申请列表
GET /api/applications?status=pending
Authorization: Bearer <token>

# 获取申请详情（含时间线）
GET /api/applications/:id
Authorization: Bearer <token>

# 提交申请（申请人）
POST /api/applications
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 5000,
  "supplier": "供应商名称",
  "purpose": "采购用途说明"
}

# 主管审批通过
POST /api/applications/:id/approve
Authorization: Bearer <token>
Content-Type: application/json

{
  "remark": "同意，预算内支出"
}

# 主管驳回
POST /api/applications/:id/reject
Authorization: Bearer <token>
Content-Type: application/json

{
  "remark": "预算不足，请调整"
}

# 申请人撤回（仅 pending 状态可撤回）
POST /api/applications/:id/withdraw
Authorization: Bearer <token>

# 错误响应（状态不允许时）
HTTP 400
{
  "error": "已审批通过的申请不能撤回，请联系财务处理" |
           "申请已撤回，不能重复撤回" |
           "已财务确认的申请不能撤回" |
           "已驳回的申请不能撤回"
}

# 财务确认
POST /api/applications/:id/confirm
Authorization: Bearer <token>
```

### 部门预算接口

```bash
# 获取部门预算列表
GET /api/departments
Authorization: Bearer <token>
```

### 账本接口

```bash
# 一致性检查
GET /api/ledger/check
Authorization: Bearer <token>

# 导出CSV账本（财务）
GET /api/ledger/export
Authorization: Bearer <token>
```

### 预算调整接口（财务）

```bash
# 单笔预算调整（追加/调减）
POST /api/budget-adjustments
Authorization: Bearer <token>
Content-Type: application/json

{
  "departmentId": 1,
  "adjustmentType": "increase",  # increase 或 decrease
  "amount": 50000,
  "reason": "Q2 设备采购预算追加"
}

# 获取调整历史
GET /api/budget-adjustments
Authorization: Bearer <token>
```

### 批量调整接口（财务）

#### 1. 批量预检

**财务**可以在提交前先进行预检，系统会返回每行的校验结果和预计调整后余额。

```bash
POST /api/budget-batches/precheck
Authorization: Bearer <token>
Content-Type: application/json

# 方式一：上传 CSV 内容
{
  "batchId": "BATCH-2024-001",
  "csvText": "部门,类型,金额,原因\n技术部,追加,50000,Q2 设备采购\n市场部,调减,10000,活动结余回收"
}

# 方式二：直接提交数据行
{
  "batchId": "BATCH-2024-001",
  "rows": [
    { "department": "技术部", "type": "追加", "amount": "50000", "reason": "Q2 设备采购" },
    { "department": "市场部", "type": "调减", "amount": "10000", "reason": "活动结余回收" }
  ]
}

# 响应示例
{
  "batchId": "BATCH-2024-001",
  "totalRows": 2,
  "validRows": 2,
  "invalidRows": 0,
  "allValid": true,
  "totalAmount": 40000,
  "results": [
    {
      "lineNumber": 1,
      "department": "技术部",
      "type": "追加",
      "amount": "50000",
      "reason": "Q2 设备采购",
      "valid": true,
      "expectedBudgetAfter": 150000
    },
    {
      "lineNumber": 2,
      "department": "市场部",
      "type": "调减",
      "amount": "10000",
      "reason": "活动结余回收",
      "valid": true,
      "expectedBudgetAfter": 70000
    }
  ]
}
```

**CSV 格式支持**：
- 表头支持中英文：部门/department, 类型/type, 金额/amount, 原因/reason
- 类型支持多种格式：追加/increase/+, 调减/decrease/-

**校验规则**：
- 部门必须存在
- 金额必须为正数
- 原因不能为空
- 调减后预算不能低于已使用 + 锁定金额

#### 2. 批量提交

**预检通过后**才能提交。提交使用数据库事务，任何一行失败则整批拒绝。

```bash
POST /api/budget-batches/submit
Authorization: Bearer <token>
Content-Type: application/json

{
  "batchId": "BATCH-2024-001",
  "rows": [
    { "lineNumber": 1, "department": "技术部", "type": "追加", "amount": "50000", "reason": "Q2 设备采购" },
    { "lineNumber": 2, "department": "市场部", "type": "调减", "amount": "10000", "reason": "活动结余回收" }
  ]
}

# 成功响应
{
  "success": true,
  "message": "批次提交成功",
  "batch": { "batch_id": "BATCH-2024-001", "status": "completed", ... },
  "lines": [...],
  "departments": [...]
}

# 失败响应（校验错误）
HTTP 400
{
  "error": "预检不通过，存在校验错误，整批拒绝",
  "batchId": "BATCH-2024-001",
  "results": [...]
}

# 失败响应（重复批次号）
HTTP 409
{
  "error": "批次 BATCH-2024-001 已存在且已处理完成，不能重复提交",
  "batchId": "BATCH-2024-001",
  "status": "completed"
}

# 失败响应（权限错误）
HTTP 403
{
  "error": "需要以下角色之一: finance"
}
```

**事务特性**：
- 所有调整在一个数据库事务中处理
- 任何一行校验失败，整批回滚，不改变任何数据
- 同部门多行会累计计算，确保中间状态也不违反预算约束
- 批次号唯一，重复提交直接拒绝

#### 3. 查询批次列表

```bash
GET /api/budget-batches?status=completed
Authorization: Bearer <token>

# 查询参数
# - status: 按状态过滤 (pending/prechecked/submitted/failed/completed)
# - batchId: 按批次号模糊搜索

# 响应
{
  "batches": [
    {
      "batch_id": "BATCH-2024-001",
      "user_id": 5,
      "user_name": "qianqi",
      "status": "completed",
      "total_rows": 2,
      "success_rows": 2,
      "failed_rows": 0,
      "total_amount": 40000,
      "created_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

#### 4. 查询批次详情

```bash
GET /api/budget-batches/:batchId
Authorization: Bearer <token>

# 响应
{
  "batch": { ... },
  "lines": [
    {
      "id": 1,
      "batch_id": "BATCH-2024-001",
      "line_number": 1,
      "department_id": 1,
      "department_name": "技术部",
      "adjustment_type": "increase",
      "amount": 50000,
      "reason": "Q2 设备采购",
      "status": "submitted",
      "budget_before": 100000,
      "budget_after": 150000,
      "adjustment_id": 10,
      "operator_name": "qianqi"
    }
  ]
}
```

#### 5. 导出批次 CSV

```bash
GET /api/budget-batches/:batchId/export
Authorization: Bearer <token>

# 返回 CSV 文件，包含以下列：
# 批次号, 行号, 部门, 调整类型, 金额, 调整前预算, 调整后预算, 原因, 状态, 校验错误, 操作人, 创建时间
```

## 验证流程

### 主流程验证（完整链路）

**步骤 1：申请人提交申请**

- 登录：zhangsan / 123456
- 点击「新建申请」
- 填写：金额 10000，供应商「联想」，用途「采购办公电脑」
- 提交
- 预期结果：
  - 申请状态为「待审批」
  - 技术部预算锁定增加 10000
  - 可用余额变为 90000（100000 - 10000）
  - 时间线记录「提交申请」

**步骤 2：主管审批**

- 退出登录，登录：wangwu / 123456（技术部主管）
- 找到刚才的申请，点击「通过」
- 预期结果：
  - 申请状态变为「主管已批」
  - 预算锁定金额不变（仍为 10000）
  - 时间线记录「主管审批」
  - 操作人记录为 wangwu

**步骤 3：财务确认**

- 退出登录，登录：qianqi / 123456（财务）
- 找到刚才的申请，点击「确认」
- 预期结果：
  - 申请状态变为「财务确认」
  - 技术部预算锁定减少 10000（变为 0）
  - 技术部预算已使用增加 10000（变为 10000）
  - 可用余额仍为 90000
  - 时间线记录「财务确认」

**步骤 4：一致性检查**

- 点击「一致性检查」→「执行一致性检查」
- 预期结果：
  - 显示「数据一致性检查通过」
  - 部门预算明细全部显示 ✓
  - 申请状态明细全部显示 ✓

**步骤 5：导出CSV账本**

- 点击「导出账本」→「导出 CSV 账本」
- 预期结果：
  - 下载 CSV 文件
  - 文件包含刚才的申请记录，状态为「财务确认」

### 失败链路验证

#### 1. 负金额校验
- 登录 zhangsan，提交金额为 -100 的申请
- 预期：后端返回 400 错误「金额必须为正数」

#### 2. 预算不足校验
- 登录 zhangsan，提交金额为 200000 的申请（超过总预算 100000）
- 预期：后端返回 400 错误「预算不足」

#### 3. 申请人自审校验
- 登录 wangwu（主管），尝试审批自己提交的申请
- 预期：后端返回 403 错误「不能审批自己提交的申请」

#### 4. 重复撤回校验
- 登录 zhangsan，提交一笔申请后撤回
- 再次尝试撤回同一笔申请
- 预期：后端返回 400 错误「申请已撤回，不能重复撤回」
- 验证：部门预算余额未发生变化

#### 5. approved 状态撤回校验
- 登录 zhangsan，提交一笔申请（状态 pending）
- 登录 wangwu（主管），审批通过该申请（状态 approved）
- 登录 zhangsan，尝试撤回该 approved 状态的申请
- 预期：后端返回 400 错误「已审批通过的申请不能撤回，请联系财务处理」
- 验证：状态仍为 approved，预算仍锁定，时间线未新增记录

#### 6. 跨部门审批校验
- 登录 wangwu（技术部主管），尝试审批市场部的申请
- 预期：后端返回 403 错误「只能审批本部门的申请」

#### 7. 越权操作校验（直接调 API）
```bash
# 使用 zhangsan 的 token 尝试调用审批接口
curl -X POST http://localhost:3000/api/applications/1/approve \
  -H "Authorization: Bearer <zhangsan_token>" \
  -H "Content-Type: application/json"
# 预期返回 403：需要以下角色之一: supervisor
```

### 一致性链路验证（服务重启后）

**步骤 1：创建多笔不同状态的申请**
- 申请 A：提交 → 审批 → 财务确认（confirmed）
- 申请 B：提交 → 审批（approved）
- 申请 C：提交（pending）
- 申请 D：提交 → 撤回（withdrawn）
- 申请 E：提交 → 驳回（rejected）

**步骤 2：记录当前状态**
- 调用 `/api/ledger/check` 记录一致性检查结果
- 记录各部门的 budget_total、budget_used、budget_locked

**步骤 3：重启服务**
```bash
# Ctrl+C 停止服务
npm start
```

**步骤 4：重启后验证**
- 调用 `/api/ledger/check`
- 预期结果：
  - `overallConsistent: true`
  - 各部门 budget_used 与重启前一致
  - 各部门 budget_locked 与重启前一致
  - 各申请状态与重启前一致
  - 时间线记录完整
- 查看导出的 CSV 账本，数据与重启前一致

## 安全特性

1. **后端权限校验**：所有操作在 API 层进行角色和数据权限校验，不依赖前端
2. **JWT 认证**：无状态 Token 认证，过期时间 24 小时
3. **密码哈希**：使用 bcryptjs 存储密码哈希，不存明文
4. **事务保证**：所有涉及预算变更的操作使用数据库事务
5. **输入校验**：所有接口参数进行类型和范围校验
6. **操作留痕**：所有状态变更写入时间线，记录操作人和时间

## 常见问题

### Q: 如何重置数据库？
```bash
npm run init
```
这会删除旧数据库并重新创建，所有数据会被清空。

### Q: 如何修改端口？
编辑 `config/config.js` 中的 `port` 字段。

### Q: 如何新增用户？
目前需要直接操作数据库：
```bash
sqlite3 data/budget.db
INSERT INTO users (username, password_hash, role, department) 
VALUES ('newuser', '<bcrypt_hash>', 'applicant', '技术部');
```

### Q: 数据库文件在哪里？
- SQLite 数据库：`data/budget.db`
- 导出的 CSV：`exports/budget-ledger-*.csv`

## 常用验证命令

### 验证撤回状态机

```bash
# 1. 登录获取 token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"zhangsan","password":"123456"}' | jq -r .token)

# 2. 提交一笔申请 (pending)
APP_ID=$(curl -s -X POST http://localhost:3000/api/applications \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":5000,"supplier":"测试","purpose":"测试"}' | jq -r .application.id)

# 3. pending 状态撤回 (应该成功，释放预算)
curl -s -X POST http://localhost:3000/api/applications/$APP_ID/withdraw \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
# 预期: {"application":{...,"status":"withdrawn"}}

# 4. 重复撤回 (应该失败，不改变余额)
curl -s -X POST http://localhost:3000/api/applications/$APP_ID/withdraw \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
# 预期: {"error":"申请已撤回，不能重复撤回"} (HTTP 400)

# 5. 新建申请并审批，测试 approved 状态撤回
APP_ID2=$(curl -s -X POST http://localhost:3000/api/applications \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":8000,"supplier":"测试2","purpose":"测试2"}' | jq -r .application.id)

SUP_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"wangwu","password":"123456"}' | jq -r .token)

curl -s -X POST http://localhost:3000/api/applications/$APP_ID2/approve \
  -H "Authorization: Bearer $SUP_TOKEN" \
  -H "Content-Type: application/json"

# 6. approved 状态撤回 (应该失败)
curl -s -X POST http://localhost:3000/api/applications/$APP_ID2/withdraw \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
# 预期: {"error":"已审批通过的申请不能撤回，请联系财务处理"} (HTTP 400)
```

### 一致性检查

```bash
FIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"qianqi","password":"123456"}' | jq -r .token)

curl -s http://localhost:3000/api/ledger/check \
  -H "Authorization: Bearer $FIN_TOKEN" | jq .
```

### 导出 CSV 账本

```bash
curl -s -OJ http://localhost:3000/api/ledger/export \
  -H "Authorization: Bearer $FIN_TOKEN"
```

## 批量导入功能验证

### 运行自动化测试脚本

项目包含完整的自动化测试脚本，覆盖所有要求的场景：

```bash
node test-batch-import.js
```

测试脚本覆盖以下 12 个场景，共 42 个测试点：

| 场景 | 说明 |
|------|------|
| 1. 权限拒绝测试 | 申请人/主管直接调用财务接口返回 JSON 权限错误 |
| 2. 预检失败测试 | 7 种不同校验错误类型（部门不存在、无效类型、负金额、零金额、空原因、调减过度） |
| 3. 预检失败后提交被拒绝 | 存在校验错误时提交被整批拒绝，数据不变 |
| 4. 成功提交批量调整 | 同部门累计调整正确，多部门预算正确 |
| 5. 重复批次幂等性 | 同一批次号重复提交被拒绝，数据不变 |
| 6. 同部门累计调减冲突 | 多行间累计调减导致低于锁定时整批拒绝 |
| 7. 一致性检查验证 | 批量调整后账本一致性检查仍通过 |
| 8. CSV 导出包含批次信息 | 账本导出包含批次号、行号、批次信息列 |
| 9. 批次 CSV 导出 | 批次结果可单独导出为 CSV |
| 10. 服务重启后持久化 | 服务重启后批次状态、明细、预算数据保持一致 |
| 11. 批量调整历史可查询 | 申请人可查看批量调整历史记录 |
| 12. CSV 格式灵活性 | 支持中英文表头、多种类型格式（追加/increase/+ 等） |

### 手动验证步骤

#### 场景 1：预检失败

**步骤：**
1. 登录财务账号 (qianqi / 123456)
2. 点击「批量调整」→「新建批次」
3. 输入以下 CSV 内容：
```
部门,类型,金额,原因
不存在的部门,追加,50000,测试
技术部,无效类型,30000,有效行
技术部,调减,-500,负数
技术部,调减,0,零金额
技术部,调减,1000,
市场部,调减,999999,调减过度
技术部,追加,10000,正常有效行
```
4. 点击「预检」
5. 预期结果：
   - 返回 7 行结果
   - 第 1-6 行显示校验错误，第 7 行通过
   - 部门预算未发生变化

#### 场景 2：成功提交

**步骤：**
1. 预检通过后，输入批次号 `TEST-SUCCESS-001`
2. 点击「确认提交」
3. 预期结果：
   - 提示「批次提交成功」
   - 部门预算按预期调整
   - 每条调整记录带有 batch_id 和行号
   - 批次状态为 completed

#### 场景 3：权限失败

**步骤：**
1. 登录申请人账号 (zhangsan / 123456)
2. 直接调用 API（浏览器开发者工具或 curl）：
```bash
ZHANGSAN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"zhangsan","password":"123456"}' | jq -r .token)

curl -s -X POST http://localhost:3000/api/budget-batches/precheck \
  -H "Authorization: Bearer $ZHANGSAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"department":"技术部","type":"追加","amount":"10000","reason":"测试"}]}'
```
3. 预期结果：返回 JSON `{"error":"需要以下角色之一: finance"}`，状态码 403

#### 场景 4：冲突失败

**步骤：**
1. 登录申请人账号 (zhangsan)，提交金额 120000 的采购申请
2. 登录主管账号 (wangwu)，审批通过该申请（锁定技术部预算 120000）
3. 登录财务账号 (qianqi)，提交以下批量调整：
```
部门,类型,金额,原因
技术部,调减,30000,第一笔调减
技术部,调减,30000,第二笔导致低于锁定
```
4. 预期结果：
   - 预检可能通过（单笔都不低于锁定）
   - 提交时整批拒绝
   - 错误信息：「第 2 行: 累计调减后预算 (110000.00) 低于已使用加锁定金额 (120000.00)」
   - 技术部预算保持 170000 不变

#### 场景 5：重复批次幂等

**步骤：**
1. 使用与场景 2 相同的批次号 `TEST-SUCCESS-001` 再次提交
2. 预期结果：
   - 返回错误：「批次 TEST-SUCCESS-001 已存在且已处理完成，不能重复提交」
   - 部门预算未变化
   - 调整记录数未增加

#### 场景 6：导出和重启验证

**步骤：**
1. 在批次列表中找到成功的批次，点击「导出」
2. 预期：下载 CSV 文件，包含批次号、行号等信息
3. 停止服务（Ctrl+C），重新启动 `npm start`
4. 登录财务账号，查看批次列表
5. 预期：
   - 批次状态和明细与重启前一致
   - 部门预算与重启前一致
   - 一致性检查通过
   - 账本导出包含批量调整记录和批次信息
