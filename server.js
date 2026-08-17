'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;
const STATUSES = [25, 50, 75, 100];
const sessions = new Map();
let writeQueue = Promise.resolve();

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function validPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'));
}

function initialDatabase() {
  const password = process.env.ADMIN_PASSWORD || 'Admin123!';
  const credentials = passwordHash(password);
  return {
    meta: { version: 1, createdAt: new Date().toISOString() },
    users: [{
      id: crypto.randomUUID(), name: 'Administrador', username: 'admin', role: 'admin',
      active: true, salt: credentials.salt, passwordHash: credentials.hash,
      createdAt: new Date().toISOString()
    }],
    tasks: []
  };
}

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const db = initialDatabase();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), { flag: 'wx' });
    console.log('Base creada. Usuario inicial: admin / ' + (process.env.ADMIN_PASSWORD || 'Admin123!'));
  }
}

function readDb() {
  ensureDatabase();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function mutateDb(mutator) {
  const operation = writeQueue.then(async () => {
    const db = readDb();
    const result = await mutator(db);
    const temp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(db, null, 2));
    fs.renameSync(temp, DB_FILE);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(Object.assign(new Error('Solicitud demasiado grande'), { status: 413 }));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const i = part.indexOf('=');
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
  }));
}

function currentUser(req) {
  const token = cookies(req).session;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; }
  const user = readDb().users.find(item => item.id === session.userId && item.active);
  return user || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role, active: user.active };
}

function clean(value, max = 200) { return String(value || '').trim().slice(0, max); }
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: 'Debes iniciar sesión' });
  return user;
}

async function api(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const input = await body(req);
    const username = clean(input.username, 60).toLowerCase();
    const user = readDb().users.find(item => item.username.toLowerCase() === username && item.active);
    if (!user || !validPassword(String(input.password || ''), user)) return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_HOURS * 3600000 });
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(cookies(req).session);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: publicUser(user) });

  if (req.method === 'GET' && url.pathname === '/api/users') {
    return json(res, 200, { users: readDb().users.filter(item => item.active).map(publicUser) });
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede crear empleados' });
    const input = await body(req);
    const name = clean(input.name, 100), username = clean(input.username, 60).toLowerCase();
    const password = String(input.password || '');
    if (!name || !/^[a-z0-9._-]{3,60}$/i.test(username) || password.length !== 4) return json(res, 400, { error: 'Nombre, usuario válido y contraseña de exactamente 4 caracteres son obligatorios' });
    try {
      const created = await mutateDb(db => {
        if (db.users.some(item => item.username.toLowerCase() === username)) throw Object.assign(new Error('El usuario ya existe'), { status: 409 });
        const credentials = passwordHash(password);
        const next = { id: crypto.randomUUID(), name, username, role: 'employee', active: true, salt: credentials.salt, passwordHash: credentials.hash, createdAt: new Date().toISOString() };
        db.users.push(next); return publicUser(next);
      });
      return json(res, 201, { user: created });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const db = readDb();
    const tasks = db.tasks.filter(task => task.assigneeId === user.id || task.creatorId === user.id).map(task => ({
      ...task,
      assigneeName: db.users.find(item => item.id === task.assigneeId)?.name || 'Usuario eliminado',
      creatorName: db.users.find(item => item.id === task.creatorId)?.name || 'Usuario eliminado'
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, { tasks });
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const input = await body(req);
    const title = clean(input.title, 140), description = clean(input.description, 2000), assigneeId = clean(input.assigneeId, 100);
    if (!title || !assigneeId) return json(res, 400, { error: 'Título y empleado asignado son obligatorios' });
    try {
      const task = await mutateDb(db => {
        if (!db.users.some(item => item.id === assigneeId && item.active)) throw Object.assign(new Error('El empleado asignado no existe'), { status: 400 });
        const now = new Date().toISOString();
        const next = { id: crypto.randomUUID(), title, description, creatorId: user.id, assigneeId, progress: 25, createdAt: now, updatedAt: now, completedAt: null };
        db.tasks.push(next); return next;
      });
      return json(res, 201, { task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const statusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    const input = await body(req), progress = Number(input.progress), taskId = statusMatch[1];
    if (!STATUSES.includes(progress)) return json(res, 400, { error: 'Estado no permitido' });
    try {
      const task = await mutateDb(db => {
        const found = db.tasks.find(item => item.id === taskId);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.assigneeId !== user.id) throw Object.assign(new Error('Solo la persona asignada puede cambiar el estado'), { status: 403 });
        found.progress = progress; found.updatedAt = new Date().toISOString(); found.completedAt = progress === 100 ? found.updatedAt : null;
        return found;
      });
      return json(res, 200, { task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  return json(res, 404, { error: 'Ruta no encontrada' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function staticFile(req, res, url) {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(path.resolve(PUBLIC_DIR)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

ensureDatabase();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else staticFile(req, res, url); }
  catch (error) { console.error(error); if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Error interno del servidor' }); else res.end(); }
});
server.listen(PORT, HOST, () => console.log(`Gestor disponible en http://localhost:${PORT}`));

module.exports = { server, readDb, STATUSES };
