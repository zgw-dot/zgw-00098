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
│   └── ledger.js          # 一致性检查和CSV导出
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
| 撤回申请 | ✅（仅自己的） | ❌ | ❌ | 只能撤回 pending/approved 状态的 |
| 财务确认 | ❌ | ❌ | ✅ | 只能确认 approved 状态的 |
| 导出CSV账本 | ❌ | ❌ | ✅ | |
| 一致性检查 | ✅ | ✅ | ✅ | 所有登录用户 |

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

# 申请人撤回
POST /api/applications/:id/withdraw
Authorization: Bearer <token>

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

#### 5. 跨部门审批校验
- 登录 wangwu（技术部主管），尝试审批市场部的申请
- 预期：后端返回 403 错误「只能审批本部门的申请」

#### 6. 越权操作校验（直接调 API）
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
