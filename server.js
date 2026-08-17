'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;
const STATUSES = [0, 25, 50, 75, 100];
const ROLES = ['admin', 'employee'];
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

function configurePush() {
  const db = readDb();
  let changed = false;
  if (!Array.isArray(db.pushSubscriptions)) { db.pushSubscriptions = []; changed = true; }
  if (!db.meta.vapidKeys) { db.meta.vapidKeys = webpush.generateVAPIDKeys(); changed = true; }
  if (changed) fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@avanza.local', db.meta.vapidKeys.publicKey, db.meta.vapidKeys.privateKey);
  return db.meta.vapidKeys.publicKey;
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
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')); }
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: 'Debes iniciar sesión' });
  return user;
}

async function notifyUser(userId, payload) {
  const db = readDb(), subscriptions = (db.pushSubscriptions || []).filter(item => item.userId === userId);
  const expired = [];
  await Promise.all(subscriptions.map(async item => {
    try { await webpush.sendNotification(item.subscription, JSON.stringify(payload)); }
    catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) expired.push(item.subscription.endpoint);
      else console.error('No se pudo enviar una notificación:', error.message);
    }
  }));
  if (expired.length) await mutateDb(data => { data.pushSubscriptions = (data.pushSubscriptions || []).filter(item => !expired.includes(item.subscription.endpoint)); });
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

  if (req.method === 'GET' && url.pathname === '/api/push/public-key') return json(res, 200, { publicKey: PUSH_PUBLIC_KEY });

  if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
    const input = await body(req), subscription = input.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return json(res, 400, { error: 'Suscripción no válida' });
    await mutateDb(db => {
      db.pushSubscriptions ||= [];
      db.pushSubscriptions = db.pushSubscriptions.filter(item => item.subscription.endpoint !== subscription.endpoint);
      db.pushSubscriptions.push({ userId: user.id, subscription, createdAt: new Date().toISOString() });
    });
    return json(res, 201, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    const allUsers = readDb().users;
    return json(res, 200, { users: (user.role === 'admin' ? allUsers : allUsers.filter(item => item.active)).map(publicUser) });
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede crear empleados' });
    const input = await body(req);
    const name = clean(input.name, 100), username = clean(input.username, 60).toLowerCase();
    const password = String(input.password || ''), role = clean(input.role, 20) || 'employee';
    if (!name || !/^[a-z0-9._-]{3,60}$/i.test(username) || password.length !== 4 || !ROLES.includes(role)) return json(res, 400, { error: 'Nombre, usuario válido, contraseña de 4 caracteres y rol válido son obligatorios' });
    try {
      const created = await mutateDb(db => {
        if (db.users.some(item => item.username.toLowerCase() === username)) throw Object.assign(new Error('El usuario ya existe'), { status: 409 });
        const credentials = passwordHash(password);
        const next = { id: crypto.randomUUID(), name, username, role, active: true, salt: credentials.salt, passwordHash: credentials.hash, createdAt: new Date().toISOString() };
        db.users.push(next); return publicUser(next);
      });
      return json(res, 201, { user: created });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (req.method === 'PATCH' && userMatch) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede editar usuarios' });
    const input = await body(req), userId = userMatch[1];
    const name = clean(input.name, 100), username = clean(input.username, 60).toLowerCase();
    const password = String(input.password || ''), role = clean(input.role, 20);
    const active = input.active === true;
    if (!name || !/^[a-z0-9._-]{3,60}$/i.test(username) || !ROLES.includes(role) || (password && password.length !== 4)) return json(res, 400, { error: 'Datos inválidos; la nueva contraseña debe tener exactamente 4 caracteres' });
    try {
      const updated = await mutateDb(db => {
        const found = db.users.find(item => item.id === userId);
        if (!found) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });
        if (db.users.some(item => item.id !== userId && item.username.toLowerCase() === username)) throw Object.assign(new Error('El nombre de usuario ya existe'), { status: 409 });
        const removesAdmin = found.role === 'admin' && found.active && (role !== 'admin' || !active);
        const activeAdmins = db.users.filter(item => item.role === 'admin' && item.active).length;
        if (removesAdmin && activeAdmins === 1) throw Object.assign(new Error('Debe permanecer al menos un administrador activo'), { status: 400 });
        found.name = name; found.username = username; found.role = role; found.active = active; found.updatedAt = new Date().toISOString();
        if (password) { const credentials = passwordHash(password); found.salt = credentials.salt; found.passwordHash = credentials.hash; }
        return publicUser(found);
      });
      return json(res, 200, { user: updated });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const db = readDb();
    const tasks = db.tasks.map(task => ({
      ...task,
      assigneeName: db.users.find(item => item.id === task.assigneeId)?.name || 'Usuario eliminado',
      creatorName: db.users.find(item => item.id === task.creatorId)?.name || 'Usuario eliminado'
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, { tasks });
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const input = await body(req);
    const title = clean(input.title, 140), description = clean(input.description, 2000), assigneeId = clean(input.assigneeId, 100), dueDate = clean(input.dueDate, 10);
    if (!title || !assigneeId || !validDate(dueDate)) return json(res, 400, { error: 'Título, empleado asignado y fecha de terminación válida son obligatorios' });
    try {
      const task = await mutateDb(db => {
        if (!db.users.some(item => item.id === assigneeId && item.active)) throw Object.assign(new Error('El empleado asignado no existe'), { status: 400 });
        const now = new Date().toISOString();
        const next = { id: crypto.randomUUID(), title, description, creatorId: user.id, assigneeId, dueDate, progress: 0, acknowledgedAt: null, createdAt: now, updatedAt: now, completedAt: null };
        db.tasks.push(next); return next;
      });
      await notifyUser(task.assigneeId, { title: 'Nueva tarea asignada', body: `${user.name}: ${task.title}`, url: '/' });
      return json(res, 201, { task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'PATCH' && taskMatch) {
    const input = await body(req), taskId = taskMatch[1];
    const title = clean(input.title, 140), description = clean(input.description, 2000), assigneeId = clean(input.assigneeId, 100), dueDate = clean(input.dueDate, 10);
    if (!title || !assigneeId || !validDate(dueDate)) return json(res, 400, { error: 'Título, empleado asignado y fecha de terminación válida son obligatorios' });
    try {
      const result = await mutateDb(db => {
        const found = db.tasks.find(item => item.id === taskId);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.creatorId !== user.id) throw Object.assign(new Error('Solo quien creó la tarea puede editarla'), { status: 403 });
        if (!db.users.some(item => item.id === assigneeId && item.active)) throw Object.assign(new Error('El empleado asignado no existe'), { status: 400 });
        const reassigned = found.assigneeId !== assigneeId;
        found.title = title; found.description = description; found.assigneeId = assigneeId; found.dueDate = dueDate; found.updatedAt = new Date().toISOString();
        if (reassigned) found.acknowledgedAt = null;
        return { task: found, reassigned };
      });
      if (result.reassigned) await notifyUser(result.task.assigneeId, { title: 'Tarea reasignada', body: `${user.name}: ${result.task.title}`, url: '/' });
      return json(res, 200, { task: result.task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const acknowledgeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/acknowledge$/);
  if (req.method === 'POST' && acknowledgeMatch) {
    try {
      const task = await mutateDb(db => {
        const found = db.tasks.find(item => item.id === acknowledgeMatch[1]);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.assigneeId !== user.id) throw Object.assign(new Error('Solo el empleado asignado puede confirmar la lectura'), { status: 403 });
        found.acknowledgedAt ||= new Date().toISOString(); return found;
      });
      return json(res, 200, { task });
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

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml' };
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
const PUSH_PUBLIC_KEY = configurePush();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else staticFile(req, res, url); }
  catch (error) { console.error(error); if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Error interno del servidor' }); else res.end(); }
});
server.listen(PORT, HOST, () => console.log(`Gestor disponible en http://localhost:${PORT}`));

module.exports = { server, readDb, STATUSES };
