const express = require('express');
const cors = require('cors');
const path = require('path');
const { port } = require('./config/config');

const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const departmentRoutes = require('./routes/departments');
const ledgerRoutes = require('./routes/ledger');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/ledger', ledgerRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   采购预算审批服务已启动                                      ║
║                                                              ║
║   管理页面: http://localhost:${port}                          ║
║   API 文档:                                                    ║
║     POST /api/auth/login           - 登录                     ║
║     GET  /api/auth/me              - 当前用户信息            ║
║     GET  /api/applications         - 申请列表                 ║
║     POST /api/applications         - 提交申请                 ║
║     POST /api/applications/:id/approve  - 主管审批           ║
║     POST /api/applications/:id/reject   - 主管驳回           ║
║     POST /api/applications/:id/withdraw - 申请人撤回         ║
║     POST /api/applications/:id/confirm  - 财务确认           ║
║     GET  /api/departments            - 部门预算               ║
║     GET  /api/ledger/check          - 一致性检查             ║
║     GET  /api/ledger/export         - 导出CSV账本            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
