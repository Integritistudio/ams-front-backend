require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const rolesRoutes = require('./routes/roles');
const modulesRoutes = require('./routes/modules');
const permissionsRoutes = require('./routes/permissions');
const departmentsRoutes = require('./routes/departments');
const ticketsRoutes = require('./routes/tickets');
const requisitionsRoutes = require('./routes/requisitions');
const vendorsRoutes = require('./routes/vendors');
const procurementRoutes = require('./routes/procurement');
const assetsRoutes = require('./routes/assets');
const kbRoutes = require('./routes/kb');
const emailTemplatesRoutes = require('./routes/emailTemplates');
const notificationsRoutes = require('./routes/notifications');
const logsRoutes = require('./routes/logs');
const settingsRoutes = require('./routes/settings');
const catalogRoutes = require('./routes/catalog');

const app = express();
const PORT = process.env.PORT || 3303;
const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || '').split(','),
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]
  .map((v) => (v || '').trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // curl / server-to-server (no Origin header)
    if (!origin) return callback(null, true);

    const normalized = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalized)) {
      // Must echo the request origin when credentials: true
      return callback(null, origin);
    }

    console.warn(`CORS blocked origin: ${origin}. Allowed: ${allowedOrigins.join(', ')}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(uploadDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'integriti-helpdesk-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/modules', modulesRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/departments', departmentsRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/requisitions', requisitionsRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/kb', kbRoutes);
app.use('/api/email-templates', emailTemplatesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/catalog', catalogRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

const server = app.listen(PORT, async () => {
  console.log(`Integriti Helpdesk API listening on port ${PORT}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
  try {
    const db = require('./config/database');
    await db.testConnection();
  } catch (err) {
    console.error('PostgreSQL connection failed:', err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process, then restart:`);
    console.error(`  netstat -ano | findstr :${PORT}`);
    console.error('  Stop-Process -Id <PID> -Force');
    process.exit(1);
  }
  console.error('Server failed to start:', err);
  process.exit(1);
});
