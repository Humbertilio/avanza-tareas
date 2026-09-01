'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const XLSX = require('xlsx');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;
const TASK_RETENTION_MS = Number(process.env.TASK_RETENTION_MS || 48 * 60 * 60 * 1000);
const STATUSES = [0, 25, 50, 75, 100];
const ROLES = ['admin', 'employee', 'client'];
const sessions = new Map();
const chatStreams = new Map();
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
    companies: [],
    clientApplications: [],
    tasks: [],
    machines: [],
    machineTasks: [],
    conversations: [],
    conversationParticipants: [],
    messages: [],
    attachments: [],
    messageReceipts: [],
    calls: [],
    inventoryItems: [],
    inventoryMovements: [],
    inventoryImports: [],
    purchaseRequests: []
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
  if (!Array.isArray(db.machines)) { db.machines = []; changed = true; }
  if (!Array.isArray(db.machineTasks)) { db.machineTasks = []; changed = true; }
  if (!Array.isArray(db.companies)) { db.companies = []; changed = true; }
  if (!Array.isArray(db.clientApplications)) { db.clientApplications = []; changed = true; }
  for (const collection of ['conversations', 'conversationParticipants', 'messages', 'attachments', 'messageReceipts', 'calls']) {
    if (!Array.isArray(db[collection])) { db[collection] = []; changed = true; }
  }
  for (const collection of ['inventoryItems', 'inventoryMovements', 'inventoryImports', 'purchaseRequests']) {
    if (!Array.isArray(db[collection])) { db[collection] = []; changed = true; }
  }
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
      if (raw.length > 12_000_000) reject(Object.assign(new Error('Solicitud demasiado grande'), { status: 413 }));
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
  return { id: user.id, name: user.name, username: user.username, role: user.role, active: user.active, companyId: user.companyId || null, position: user.position || '', phone: user.phone || '', email: user.email || '' };
}

function clean(value, max = 200) { return String(value || '').trim().slice(0, max); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')); }
function validPhone(value) { return !value || /^\d{3}-\d{3}-\d{4}$/.test(value); }
function inventoryNumber(value, integer = true) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (integer ? !/^\d+$/.test(normalized) : !/^\d+(?:\.\d)?$/.test(normalized)) throw Object.assign(new Error(integer ? 'El valor debe ser entero' : 'Ancho admite máximo un decimal'), { status: 400 });
  return Number(normalized);
}
function validatedInventoryItem(input) {
  const material = clean(input.material, 20), ubicacion = clean(input.ubicacion, 20), externalId = clean(input.externalId ?? input.id, 20), observacion = clean(input.observacion, 100), destino = clean(input.destino, 100);
  if (!material || material.length > 4 || !/^[a-z0-9]+$/i.test(material)) throw Object.assign(new Error('Material debe ser alfanumérico y tener máximo 4 caracteres'), { status: 400 });
  if (ubicacion.length > 6 || (ubicacion && !/^[a-z0-9 ]+$/i.test(ubicacion))) throw Object.assign(new Error('Ubicación debe ser alfanumérica y tener máximo 6 caracteres'), { status: 400 });
  if (externalId.length > 7 || (externalId && !/^[a-z0-9]+$/i.test(externalId))) throw Object.assign(new Error('ID debe ser alfanumérico y tener máximo 7 caracteres'), { status: 400 });
  if (observacion.length > 40 || destino.length > 40) throw Object.assign(new Error('Observación y destino admiten máximo 40 caracteres'), { status: 400 });
  return { material: material.toUpperCase(), calibre: inventoryNumber(input.calibre), ancho: inventoryNumber(input.ancho, false), peso: inventoryNumber(input.peso), gramaje: inventoryNumber(input.gramaje), ubicacion, externalId, observacion, destino };
}
function inventoryRowHash(item) { return crypto.createHash('sha256').update(JSON.stringify([item.material,item.calibre,item.ancho,item.peso,item.gramaje,item.ubicacion,item.externalId,item.observacion,item.destino])).digest('hex'); }
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: 'Debes iniciar sesión' });
  return user;
}

function chatParticipant(db, conversationId, userId) { return (db.conversationParticipants || []).find(item => item.conversationId === conversationId && item.userId === userId); }
function chatUserIds(db, conversationId) { return (db.conversationParticipants || []).filter(item => item.conversationId === conversationId).map(item => item.userId); }
function emitChat(userId, event, payload) {
  for (const res of chatStreams.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function emitConversation(db, conversationId, event, payload) { chatUserIds(db, conversationId).forEach(userId => emitChat(userId, event, payload)); }
function publicAttachment(item) { return { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size, url: `/api/chat/attachments/${item.id}` }; }
function publicMessage(db, message) {
  const receipts = (db.messageReceipts || []).filter(item => item.messageId === message.id);
  const original = message.forwardedFromMessageId ? db.messages.find(item => item.id === message.forwardedFromMessageId) : null;
  return { ...message, senderName: db.users.find(item => item.id === message.senderId)?.name || 'Usuario eliminado', forwardedFromSenderName: original ? db.users.find(item => item.id === original.senderId)?.name || 'Usuario eliminado' : null, attachments: (db.attachments || []).filter(item => item.messageId === message.id).map(publicAttachment), delivered: receipts.filter(item => item.userId !== message.senderId).every(item => item.deliveredAt), read: receipts.filter(item => item.userId !== message.senderId).every(item => item.readAt) };
}
async function sendDirectSystemMessage(sender, recipientId, text, notificationBody, metadata = {}) {
  if (!recipientId || recipientId === sender.id) return null;
  const result = await mutateDb(db => {
    const participantConversationIds = (db.conversationParticipants || []).filter(item => item.userId === sender.id).map(item => item.conversationId);
    let conversation = db.conversations.find(item => item.type === 'direct' && participantConversationIds.includes(item.id) && chatUserIds(db,item.id).length === 2 && chatUserIds(db,item.id).includes(recipientId));
    const now = new Date().toISOString();
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), type: 'direct', title: null, createdBy: sender.id, createdAt: now, updatedAt: now, pinnedBy: [], settings: {} };
      db.conversations.push(conversation);
      [sender.id,recipientId].forEach(userId => db.conversationParticipants.push({ id: crypto.randomUUID(), conversationId: conversation.id, userId, role: 'member', joinedAt: now, lastReadAt: null, lastReadMessageId: null, muted: false }));
    }
    const message = { id: crypto.randomUUID(), conversationId: conversation.id, senderId: sender.id, type: 'text', text, replyToMessageId: null, forwardedFromMessageId: null, deletedAt: null, createdAt: now, updatedAt: now, systemType: metadata.systemType || 'task_assignment', relatedTaskType: metadata.relatedTaskType || null, relatedTaskId: metadata.relatedTaskId || null };
    db.messages.push(message); conversation.updatedAt = now;
    [sender.id,recipientId].forEach(userId => db.messageReceipts.push({ id: crypto.randomUUID(), messageId: message.id, userId, deliveredAt: userId === sender.id ? now : null, readAt: userId === sender.id ? now : null }));
    return { conversationId: conversation.id, message };
  });
  const db = readDb(), payload = publicMessage(db,result.message), badgeCount = db.messageReceipts.filter(receipt => receipt.userId === recipientId && !receipt.readAt).length;
  emitChat(recipientId,'message',payload); emitChat(sender.id,'message',payload);
  await notifyUser(recipientId,{ title: `Nueva tarea de ${sender.name}`, body: notificationBody, url: `/#chat/${result.conversationId}`, badgeCount });
  return payload;
}
function assignmentMessage(task, senderName, heading = 'Nueva tarea asignada') {
  const [year,month,day] = task.dueDate.split('-');
  return `${heading}\n\nTarea: ${task.title}\nDescripción: ${task.description || 'Sin descripción'}\nAsignada por: ${senderName}\nFecha de finalización: ${day}/${month}/${year}`;
}
function completionMessage(task, senderName, heading = 'Tarea finalizada') {
  return `${heading}\n\nTarea: ${task.title}\nDescripción: ${task.description || 'Sin descripción'}\nFinalizada por: ${senderName}\nFecha y hora: ${new Date().toLocaleString('es')}`;
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

async function purgeExpiredTasks() {
  if (TASK_RETENTION_MS <= 0) return;
  const cutoff = Date.now() - TASK_RETENTION_MS;
  const expired=task=>task.progress===100&&task.completedAt&&new Date(task.completedAt).getTime()<=cutoff;
  const current=readDb(),hasExpired=current.tasks.some(expired)||(current.machineTasks||[]).some(expired);
  if(hasExpired)await mutateDb(db=>{db.tasks=db.tasks.filter(task=>!expired(task));db.machineTasks=(db.machineTasks||[]).filter(task=>!expired(task));});
}

async function api(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/client-applications') {
    const input=await body(req),company=input.company||{},contact=input.contact||{},name=clean(company.name,120),taxId=clean(company.taxId,60),address=clean(company.address,180),city=clean(company.city,100),companyPhone=clean(company.phone,60),contactName=clean(contact.name,100),position=clean(contact.position,100),phone=clean(contact.phone,60),email=clean(contact.email,120),username=clean(contact.username,60).toLowerCase(),password=String(contact.password||'');
    if(!name||!contactName||!/^[a-z0-9._-]{3,60}$/i.test(username)||password.length!==4)return json(res,400,{error:'Empresa, nombre, usuario y contraseña de 4 caracteres son obligatorios'});
    if(!validPhone(companyPhone)||!validPhone(phone))return json(res,400,{error:'El teléfono debe usar el formato 000-000-0000'});
    try{const application=await mutateDb(db=>{if(db.users.some(item=>item.username.toLowerCase()===username)||(db.clientApplications||[]).some(item=>item.status==='pending'&&item.username===username))throw Object.assign(new Error('Ese usuario ya existe o tiene una solicitud pendiente'),{status:409});const credentials=passwordHash(password),now=new Date().toISOString(),next={id:crypto.randomUUID(),status:'pending',company:{name,taxId,address,city,phone:companyPhone},contact:{name:contactName,position,phone,email},username,salt:credentials.salt,passwordHash:credentials.hash,createdAt:now,updatedAt:now};db.clientApplications.push(next);return{id:next.id,status:next.status};});return json(res,201,{application});}catch(error){return json(res,error.status||500,{error:error.message});}
  }

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

  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const db = readDb();
    const items = (db.inventoryItems || []).filter(item => user.role !== 'client' || item.active);
    const orders = user.role === 'admin' ? (db.purchaseRequests || []) : user.role === 'client' ? (db.purchaseRequests || []).filter(item => item.customerId === user.id) : [];
    return json(res, 200, {
      items,
      movements: user.role === 'client' ? [] : (db.inventoryMovements || []).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
      imports: user.role === 'client' ? [] : (db.inventoryImports || []).slice().sort((a,b) => b.importedAt.localeCompare(a.importedAt)),
      orders: orders.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt))
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/items') {
    if (!['admin','employee'].includes(user.role)) return json(res, 403, { error: 'No autorizado' });
    try {
      const values = validatedInventoryItem(await body(req));
      const item = await mutateDb(db => {
        if (values.externalId && (db.inventoryItems || []).some(row => row.externalId.toLowerCase() === values.externalId.toLowerCase())) throw Object.assign(new Error('Ese ID ya existe'), { status: 409 });
        const now = new Date().toISOString(), next = { id: crypto.randomUUID(), ...values, active: true, rowHash: inventoryRowHash(values), createdAt: now, updatedAt: now };
        db.inventoryItems.push(next); return next;
      });
      return json(res, 201, { item });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const inventoryItemMatch = url.pathname.match(/^\/api\/inventory\/items\/([^/]+)$/);
  if (req.method === 'PATCH' && inventoryItemMatch) {
    if (!['admin','employee'].includes(user.role)) return json(res, 403, { error: 'No autorizado' });
    try {
      const values = validatedInventoryItem(await body(req));
      const item = await mutateDb(db => {
        const found = db.inventoryItems.find(row => row.id === inventoryItemMatch[1]);
        if (!found) throw Object.assign(new Error('Artículo no encontrado'), { status: 404 });
        if (values.externalId && db.inventoryItems.some(row => row.id !== found.id && row.externalId.toLowerCase() === values.externalId.toLowerCase())) throw Object.assign(new Error('Ese ID ya existe'), { status: 409 });
        Object.assign(found, values, { rowHash: inventoryRowHash(values), updatedAt: new Date().toISOString() }); return found;
      });
      return json(res, 200, { item });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
  if (req.method === 'DELETE' && inventoryItemMatch) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede borrar' });
    try {
      await mutateDb(db => {
        const index = db.inventoryItems.findIndex(row => row.id === inventoryItemMatch[1]);
        if (index < 0) throw Object.assign(new Error('Artículo no encontrado'), { status: 404 });
        db.inventoryItems.splice(index, 1);
      });
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/movements') {
    if (!['admin','employee'].includes(user.role)) return json(res, 403, { error: 'No autorizado' });
    const input = await body(req), type = clean(input.type, 10), itemId = clean(input.itemId, 100), destination = clean(input.destination, 40), note = clean(input.note, 40);
    if (!['entry','exit'].includes(type) || (type === 'exit' && !destination)) return json(res, 400, { error: 'Movimiento o destino inválido' });
    try {
      const movement = await mutateDb(db => {
        const item = db.inventoryItems.find(row => row.id === itemId);
        if (!item) throw Object.assign(new Error('Artículo no encontrado'), { status: 404 });
        if (type === 'exit' && !item.active) throw Object.assign(new Error('El rollo ya está inactivo'), { status: 409 });
        if (type === 'entry' && item.active) throw Object.assign(new Error('El rollo ya está activo'), { status: 409 });
        const now = new Date().toISOString();
        item.active = type === 'entry'; item.destino = type === 'exit' ? destination : ''; item.updatedAt = now;
        const next = { id: crypto.randomUUID(), itemId, type, destination: type === 'exit' ? destination : '', note, actorId: user.id, actor: user.name, material: item.material, calibre: item.calibre, ancho: item.ancho, createdAt: now };
        db.inventoryMovements.push(next); return next;
      });
      return json(res, 201, { movement });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/orders') {
    if (user.role !== 'client') return json(res, 403, { error: 'Solo los clientes pueden enviar solicitudes' });
    const input = await body(req), itemIds = [...new Set(Array.isArray(input.itemIds) ? input.itemIds.map(id => clean(id, 100)) : [])], comments = clean(input.comments, 500);
    if (!itemIds.length) return json(res, 400, { error: 'Selecciona al menos un artículo' });
    try {
      const order = await mutateDb(db => {
        if (itemIds.some(id => !db.inventoryItems.some(item => item.id === id && item.active))) throw Object.assign(new Error('Uno de los artículos ya no está disponible'), { status: 409 });
        const next = { id: crypto.randomUUID(), customerId: user.id, customer: user.name, companyId: user.companyId || null, comments, itemIds, status: 'pending', createdAt: new Date().toISOString() };
        db.purchaseRequests.push(next); return next;
      });
      await Promise.all(readDb().users.filter(account => account.role === 'admin' && account.active).map(account => notifyUser(account.id, { title: 'Nueva solicitud de inventario', body: `${user.name} seleccionó ${itemIds.length} artículo(s)`, url: '/#inventory' })));
      return json(res, 201, { order });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const inventoryOrderMatch = url.pathname.match(/^\/api\/inventory\/orders\/([^/]+)$/);
  if (req.method === 'PATCH' && inventoryOrderMatch) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede actualizar solicitudes' });
    const status = clean((await body(req)).status, 20), allowed = ['pending','review','approved','rejected','completed'];
    if (!allowed.includes(status)) return json(res, 400, { error: 'Estado inválido' });
    try {
      const order = await mutateDb(db => { const found = db.purchaseRequests.find(row => row.id === inventoryOrderMatch[1]); if (!found) throw Object.assign(new Error('Solicitud no encontrada'), { status: 404 }); found.status = status; found.updatedAt = new Date().toISOString(); return found; });
      return json(res, 200, { order });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/import') {
    if (!['admin','employee'].includes(user.role)) return json(res, 403, { error: 'No autorizado para importar' });
    try {
      const input = await body(req), fileName = clean(input.fileName, 240), encoded = String(input.content || '');
      if (!fileName || !encoded || encoded.length > 10_000_000) return json(res, 400, { error: 'Archivo inválido o demasiado grande' });
      const buffer = Buffer.from(encoded, 'base64'), fileHash = crypto.createHash('sha256').update(buffer).digest('hex'), workbook = XLSX.read(buffer, { type: 'buffer' });
      const result = await mutateDb(db => {
        let imported = 0, skipped = 0; const sheets = [];
        for (const sheetName of workbook.SheetNames) {
          if (db.inventoryImports.some(record => record.fileHash === fileHash && record.sheetName === sheetName)) { sheets.push({ sheetName, duplicate: true }); continue; }
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }).slice(0, 10000);
          let sheetImported = 0, sheetSkipped = 0;
          for (const row of rows) {
            const lower = Object.fromEntries(Object.entries(row).map(([key,value]) => [key.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''), value]));
            try {
              const values = validatedInventoryItem({ material: lower.material, calibre: lower.calibre, ancho: lower.ancho, peso: lower.peso, gramaje: lower.gramaje, ubicacion: lower.ubicacion, id: lower.id, observacion: lower.observacion, destino: lower.destino });
              const rowHash = inventoryRowHash(values);
              if ((values.externalId && db.inventoryItems.some(item => item.externalId.toLowerCase() === values.externalId.toLowerCase())) || db.inventoryItems.some(item => item.rowHash === rowHash)) { sheetSkipped++; continue; }
              const now = new Date().toISOString(); db.inventoryItems.push({ id: crypto.randomUUID(), ...values, active: true, rowHash, createdAt: now, updatedAt: now }); sheetImported++;
            } catch { sheetSkipped++; }
          }
          db.inventoryImports.push({ id: crypto.randomUUID(), fileName, fileHash, sheetName, importedRows: sheetImported, skippedRows: sheetSkipped, importedBy: user.name, importedAt: new Date().toISOString() });
          imported += sheetImported; skipped += sheetSkipped; sheets.push({ sheetName, imported: sheetImported, skipped: sheetSkipped });
        }
        if (sheets.length && sheets.every(sheet => sheet.duplicate)) throw Object.assign(new Error('Este archivo ya fue importado'), { status: 409 });
        return { imported, skipped, sheets };
      });
      return json(res, 201, result);
    } catch (error) { return json(res, error.status || 400, { error: error.message || 'No se pudo leer el archivo' }); }
  }

  if(user.role==='client'&&!url.pathname.startsWith('/api/chat/')&&!url.pathname.startsWith('/api/companies')&&!url.pathname.startsWith('/api/inventory'))return json(res,403,{error:'Los clientes solo tienen acceso a su empresa e inventario'});

  if (req.method === 'GET' && url.pathname === '/api/users') {
    const allUsers = readDb().users;
    return json(res, 200, { users: (user.role === 'admin' ? allUsers : allUsers.filter(item => item.active)).map(publicUser).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })) });
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede crear empleados' });
    const input = await body(req);
    const name = clean(input.name, 100), username = clean(input.username, 60).toLowerCase();
    const password = String(input.password || ''), role = clean(input.role, 20) || 'employee';
    if (!name || !/^[a-z0-9._-]{3,60}$/i.test(username) || password.length !== 4 || !ROLES.includes(role) || role==='client') return json(res, 400, { error: 'Los contactos cliente deben crearse desde Empresas' });
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
        if((found.companyId&&role!=='client')||(!found.companyId&&role==='client'))throw Object.assign(new Error('El rol Cliente se administra desde Empresas'),{status:400});
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

  if (req.method === 'GET' && url.pathname === '/api/companies') {
    const db=readDb();
    if(user.role!=='admin'&&user.role!=='client')return json(res,403,{error:'No tiene acceso a empresas'});
    const allowed=user.role==='admin'?db.companies:db.companies.filter(company=>company.id===user.companyId);
    return json(res,200,{companies:allowed.map(company=>{const conversation=db.conversations.find(item=>item.companyId===company.id);const participantIds=conversation?chatUserIds(db,conversation.id):[],memberIds=participantIds.filter(id=>db.users.some(item=>item.id===id&&['employee','admin'].includes(item.role)));return{...company,conversationId:conversation?.id||null,contacts:db.users.filter(item=>item.role==='client'&&item.companyId===company.id).map(publicUser).sort((a,b)=>a.name.localeCompare(b.name,'es')),memberIds,employeeIds:memberIds};}).sort((a,b)=>a.name.localeCompare(b.name,'es'))});
  }

  if(req.method==='GET'&&url.pathname==='/api/client-applications'){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede revisar solicitudes'});const applications=(readDb().clientApplications||[]).filter(item=>item.status==='pending').map(item=>({id:item.id,status:item.status,company:item.company,contact:item.contact,username:item.username,createdAt:item.createdAt})).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));return json(res,200,{applications});}
  const applicationMatch=url.pathname.match(/^\/api\/client-applications\/([^/]+)$/);
  if(req.method==='DELETE'&&applicationMatch){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede rechazar solicitudes'});try{await mutateDb(db=>{const found=(db.clientApplications||[]).find(item=>item.id===applicationMatch[1]&&item.status==='pending');if(!found)throw Object.assign(new Error('Solicitud no encontrada'),{status:404});found.status='rejected';found.reviewedAt=new Date().toISOString();found.reviewedBy=user.id;});return json(res,200,{ok:true});}catch(error){return json(res,error.status||500,{error:error.message});}}

  if(req.method==='POST'&&url.pathname==='/api/companies'){
    if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede crear empresas'});
    const input=await body(req),applicationId=clean(input.applicationId,100),application=applicationId?(readDb().clientApplications||[]).find(item=>item.id===applicationId&&item.status==='pending'):null,sourceCompany=application?.company||input,sourceContact=application?{...application.contact,username:application.username}:input.contact||{},name=clean(sourceCompany.name,120),taxId=clean(sourceCompany.taxId,60),address=clean(sourceCompany.address,180),city=clean(sourceCompany.city,100),phone=clean(sourceCompany.phone,60),memberIds=[...new Set((Array.isArray(input.memberIds)?input.memberIds:Array.isArray(input.employeeIds)?input.employeeIds:[]).map(id=>clean(id,100)))],contactName=clean(sourceContact.name,100),username=clean(sourceContact.username,60).toLowerCase(),password=String(sourceContact.password||''),position=clean(sourceContact.position,100),contactPhone=clean(sourceContact.phone,60),email=clean(sourceContact.email,120);
    if(applicationId&&!application)return json(res,404,{error:'Solicitud pendiente no encontrada'});if(!name||memberIds.length<2||!contactName||!/^[a-z0-9._-]{3,60}$/i.test(username)||(!application&&password.length!==4))return json(res,400,{error:'Empresa, contacto y al menos dos empleados o administradores son obligatorios'});
    try{const created=await mutateDb(db=>{if(db.companies.some(item=>item.name.toLowerCase()===name.toLowerCase()))throw Object.assign(new Error('Ya existe una empresa con ese nombre'),{status:409});if(db.users.some(item=>item.username.toLowerCase()===username))throw Object.assign(new Error('El usuario ya existe'),{status:409});if(memberIds.some(id=>!db.users.some(item=>item.id===id&&item.active&&['employee','admin'].includes(item.role))))throw Object.assign(new Error('Seleccione empleados o administradores activos'),{status:400});const pending=applicationId?(db.clientApplications||[]).find(item=>item.id===applicationId&&item.status==='pending'):null;if(applicationId&&!pending)throw Object.assign(new Error('Solicitud pendiente no encontrada'),{status:404});const now=new Date().toISOString(),company={id:crypto.randomUUID(),name,taxId,address,city,phone,status:'approved',createdAt:now,updatedAt:now},credentials=pending?{salt:pending.salt,hash:pending.passwordHash}:passwordHash(password),client={id:crypto.randomUUID(),name:contactName,username,role:'client',companyId:company.id,position,phone:contactPhone,email,active:true,salt:credentials.salt,passwordHash:credentials.hash,createdAt:now},conversation={id:crypto.randomUUID(),type:'group',title:name,companyId:company.id,createdBy:user.id,createdAt:now,updatedAt:now,pinnedBy:[],settings:{clientGroup:true}};db.companies.push(company);db.users.push(client);db.conversations.push(conversation);[client.id,...memberIds].forEach(userId=>db.conversationParticipants.push({id:crypto.randomUUID(),conversationId:conversation.id,userId,role:'member',joinedAt:now,lastReadAt:null,lastReadMessageId:null,muted:false}));if(pending){pending.status='approved';pending.reviewedAt=now;pending.reviewedBy=user.id;pending.companyId=company.id;}return{company,contact:publicUser(client),conversationId:conversation.id};});created.memberIds=memberIds;return json(res,201,created);}catch(error){return json(res,error.status||500,{error:error.message});}
  }

  const companyMatch=url.pathname.match(/^\/api\/companies\/([^/]+)$/);
  if(req.method==='PATCH'&&companyMatch){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede editar empresas'});const input=await body(req),name=clean(input.name,120),taxId=clean(input.taxId,60),address=clean(input.address,180),city=clean(input.city,100),phone=clean(input.phone,60),memberIds=[...new Set((Array.isArray(input.memberIds)?input.memberIds:Array.isArray(input.employeeIds)?input.employeeIds:[]).map(id=>clean(id,100)))];if(!name||memberIds.length<2)return json(res,400,{error:'Nombre y al menos dos empleados o administradores son obligatorios'});try{const company=await mutateDb(db=>{const found=db.companies.find(item=>item.id===companyMatch[1]);if(!found)throw Object.assign(new Error('Empresa no encontrada'),{status:404});if(memberIds.some(id=>!db.users.some(item=>item.id===id&&item.active&&['employee','admin'].includes(item.role))))throw Object.assign(new Error('Seleccione empleados o administradores activos'),{status:400});const conversation=db.conversations.find(item=>item.companyId===found.id);if(!conversation)throw Object.assign(new Error('Grupo de empresa no encontrado'),{status:404});found.name=name;found.taxId=taxId;found.address=address;found.city=city;found.phone=phone;found.updatedAt=new Date().toISOString();conversation.title=name;conversation.updatedAt=found.updatedAt;const contactIds=db.users.filter(item=>item.role==='client'&&item.companyId===found.id&&item.active).map(item=>item.id),keep=new Set([...contactIds,...memberIds]);db.conversationParticipants=db.conversationParticipants.filter(item=>item.conversationId!==conversation.id||keep.has(item.userId));for(const userId of keep)if(!chatParticipant(db,conversation.id,userId))db.conversationParticipants.push({id:crypto.randomUUID(),conversationId:conversation.id,userId,role:'member',joinedAt:found.updatedAt,lastReadAt:null,lastReadMessageId:null,muted:false});return found;});return json(res,200,{company});}catch(error){return json(res,error.status||500,{error:error.message});}}
  if(req.method==='DELETE'&&companyMatch){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede eliminar empresas'});try{await mutateDb(db=>{const companyId=companyMatch[1],index=db.companies.findIndex(item=>item.id===companyId);if(index<0)throw Object.assign(new Error('Empresa no encontrada'),{status:404});const conversationIds=db.conversations.filter(item=>item.companyId===companyId).map(item=>item.id),messageIds=db.messages.filter(item=>conversationIds.includes(item.conversationId)).map(item=>item.id),clientIds=db.users.filter(item=>item.companyId===companyId).map(item=>item.id);db.companies.splice(index,1);db.users=db.users.filter(item=>!clientIds.includes(item.id));db.conversations=db.conversations.filter(item=>!conversationIds.includes(item.id));db.conversationParticipants=db.conversationParticipants.filter(item=>!conversationIds.includes(item.conversationId));db.messages=db.messages.filter(item=>!conversationIds.includes(item.conversationId));db.attachments=db.attachments.filter(item=>!messageIds.includes(item.messageId));db.messageReceipts=db.messageReceipts.filter(item=>!messageIds.includes(item.messageId));db.pushSubscriptions=(db.pushSubscriptions||[]).filter(item=>!clientIds.includes(item.userId));});return json(res,200,{ok:true});}catch(error){return json(res,error.status||500,{error:error.message});}}

  const contactMatch=url.pathname.match(/^\/api\/companies\/([^/]+)\/contacts(?:\/([^/]+))?$/);
  if(req.method==='POST'&&contactMatch&&!contactMatch[2]){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede agregar contactos'});const input=await body(req),name=clean(input.name,100),username=clean(input.username,60).toLowerCase(),password=String(input.password||''),position=clean(input.position,100),phone=clean(input.phone,60),email=clean(input.email,120);if(!name||!/^[a-z0-9._-]{3,60}$/i.test(username)||password.length!==4)return json(res,400,{error:'Nombre, usuario y contraseña de 4 caracteres son obligatorios'});try{const contact=await mutateDb(db=>{const company=db.companies.find(item=>item.id===contactMatch[1]);if(!company)throw Object.assign(new Error('Empresa no encontrada'),{status:404});if(db.users.some(item=>item.username.toLowerCase()===username))throw Object.assign(new Error('El usuario ya existe'),{status:409});const conversation=db.conversations.find(item=>item.companyId===company.id),now=new Date().toISOString(),credentials=passwordHash(password),next={id:crypto.randomUUID(),name,username,role:'client',companyId:company.id,position,phone,email,active:true,salt:credentials.salt,passwordHash:credentials.hash,createdAt:now};db.users.push(next);db.conversationParticipants.push({id:crypto.randomUUID(),conversationId:conversation.id,userId:next.id,role:'member',joinedAt:now,lastReadAt:null,lastReadMessageId:null,muted:false});return publicUser(next);});return json(res,201,{contact});}catch(error){return json(res,error.status||500,{error:error.message});}}
  if(req.method==='PATCH'&&contactMatch&&contactMatch[2]){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede editar contactos'});const input=await body(req),name=clean(input.name,100),username=clean(input.username,60).toLowerCase(),password=String(input.password||''),position=clean(input.position,100),phone=clean(input.phone,60),email=clean(input.email,120),active=input.active===true;if(!name||!/^[a-z0-9._-]{3,60}$/i.test(username)||(password&&password.length!==4))return json(res,400,{error:'Datos de contacto inválidos'});try{const contact=await mutateDb(db=>{const found=db.users.find(item=>item.id===contactMatch[2]&&item.companyId===contactMatch[1]&&item.role==='client');if(!found)throw Object.assign(new Error('Contacto no encontrado'),{status:404});if(db.users.some(item=>item.id!==found.id&&item.username.toLowerCase()===username))throw Object.assign(new Error('El usuario ya existe'),{status:409});found.name=name;found.username=username;found.position=position;found.phone=phone;found.email=email;found.active=active;found.updatedAt=new Date().toISOString();if(password){const credentials=passwordHash(password);found.salt=credentials.salt;found.passwordHash=credentials.hash;}return publicUser(found);});return json(res,200,{contact});}catch(error){return json(res,error.status||500,{error:error.message});}}

  if(req.method==='POST'&&url.pathname==='/api/chat/groups'){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede crear grupos'});const input=await body(req),title=clean(input.title,120),participantIds=[...new Set(Array.isArray(input.participantIds)?input.participantIds.map(id=>clean(id,100)):[])];if(!title||participantIds.length<2)return json(res,400,{error:'Nombre y al menos dos integrantes son obligatorios'});try{const conversation=await mutateDb(db=>{if(participantIds.some(id=>!db.users.some(item=>item.id===id&&item.active&&item.role!=='client')))throw Object.assign(new Error('Los clientes solo pueden estar en el grupo de su empresa'),{status:400});const now=new Date().toISOString(),next={id:crypto.randomUUID(),type:'group',title,companyId:null,createdBy:user.id,createdAt:now,updatedAt:now,pinnedBy:[],settings:{}};db.conversations.push(next);participantIds.forEach(userId=>db.conversationParticipants.push({id:crypto.randomUUID(),conversationId:next.id,userId,role:'member',joinedAt:now,lastReadAt:null,lastReadMessageId:null,muted:false}));return next;});participantIds.forEach(id=>emitChat(id,'conversation',{conversationId:conversation.id}));return json(res,201,{conversation});}catch(error){return json(res,error.status||500,{error:error.message});}}

  if (req.method === 'GET' && url.pathname === '/api/chat/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    if (!chatStreams.has(user.id)) chatStreams.set(user.id, new Set());
    chatStreams.get(user.id).add(res);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(heartbeat); chatStreams.get(user.id)?.delete(res); if (!chatStreams.get(user.id)?.size) chatStreams.delete(user.id); });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/members') {
    const members=user.role==='client'?[]:readDb().users.filter(item=>item.active&&item.id!==user.id&&item.role!=='client').map(publicUser).sort((a,b)=>a.name.localeCompare(b.name,'es',{sensitivity:'base'}));
    return json(res, 200, { members });
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/conversations') {
    const db = readDb(), memberships = user.role === 'admin' ? db.conversations.map(conversation => ({ conversationId: conversation.id, observer: !chatParticipant(db,conversation.id,user.id) })) : (db.conversationParticipants || []).filter(item => item.userId === user.id && (user.role!=='client'||db.conversations.some(conversation=>conversation.id===item.conversationId&&conversation.companyId===user.companyId)));
    const conversations = memberships.map(membership => {
      const conversation = db.conversations.find(item => item.id === membership.conversationId);
      if (!conversation) return null;
      const participantIds = chatUserIds(db, conversation.id), observer = !participantIds.includes(user.id), otherId = participantIds.find(id => id !== user.id), participantUsers = participantIds.map(id => db.users.find(item => item.id === id)).filter(Boolean), other = conversation.type==='direct'&&!observer ? db.users.find(item => item.id === otherId) : null, displayName = conversation.type==='group' ? conversation.title || 'Grupo' : observer ? participantUsers.map(item=>item.name).join(' ↔ ') : other?.name || 'Usuario eliminado';
      const messages = db.messages.filter(item => item.conversationId === conversation.id && !item.deletedAt && !(item.deletedForUserIds||[]).includes(user.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      const last = messages[messages.length - 1], unread = observer ? 0 : (db.messageReceipts || []).filter(item => item.userId === user.id && !item.readAt && messages.some(message => message.id === item.messageId)).length;
      return { id: conversation.id, type: conversation.type, companyId:conversation.companyId||null, title:conversation.title||null, user: other ? publicUser(other) : { id: conversation.id, name: displayName, username: '', role: 'group', active: true }, participants: participantUsers.map(publicUser), observer, lastMessage: last ? publicMessage(db,last) : null, unread, updatedAt: last?.createdAt || conversation.updatedAt || conversation.createdAt, pinned: (conversation.pinnedBy || []).includes(user.id) };
    }).filter(Boolean).sort((a,b)=>(b.pinned-a.pinned)||b.updatedAt.localeCompare(a.updatedAt));
    return json(res, 200, { conversations, totalUnread: conversations.reduce((sum,item)=>sum+item.unread,0) });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/conversations') {
    if(user.role==='client')return json(res,403,{error:'Los clientes utilizan el grupo de su empresa'});
    const input = await body(req), otherId = clean(input.userId, 100);
    if (!otherId || otherId === user.id) return json(res, 400, { error: 'Seleccione otro usuario' });
    try {
      const conversation = await mutateDb(db => {
        if (!db.users.some(item => item.id === otherId && item.active && item.role!=='client')) throw Object.assign(new Error('Los contactos cliente solo participan en el grupo de su empresa'), { status: 400 });
        const existing = db.conversations.find(item => item.type === 'direct' && chatUserIds(db,item.id).length === 2 && chatUserIds(db,item.id).includes(user.id) && chatUserIds(db,item.id).includes(otherId));
        if (existing) return existing;
        const now = new Date().toISOString(), next = { id: crypto.randomUUID(), type: 'direct', title: null, createdBy: user.id, createdAt: now, updatedAt: now, pinnedBy: [], settings: {} };
        db.conversations.push(next);
        [user.id,otherId].forEach(userId => db.conversationParticipants.push({ id: crypto.randomUUID(), conversationId: next.id, userId, role: 'member', joinedAt: now, lastReadAt: null, lastReadMessageId: null, muted: false }));
        return next;
      });
      emitChat(otherId, 'conversation', { conversationId: conversation.id });
      return json(res, 201, { conversation });
    } catch(error){ return json(res,error.status||500,{error:error.message}); }
  }

  const chatMessagesMatch = url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/messages$/);
  if (req.method === 'GET' && chatMessagesMatch) {
    const db = readDb(), conversationId = chatMessagesMatch[1];
    if (!chatParticipant(db,conversationId,user.id) && user.role !== 'admin') return json(res,403,{error:'No pertenece a esta conversación'});
    const observing = !chatParticipant(db,conversationId,user.id);
    const now = new Date().toISOString(), changed = [];
    if(!observing)await mutateDb(data => { (data.messageReceipts || []).filter(item => item.userId === user.id && !item.deliveredAt && data.messages.some(message => message.id === item.messageId && message.conversationId === conversationId)).forEach(item => { item.deliveredAt=now; changed.push(item.messageId); }); });
    const fresh = readDb(); changed.forEach(messageId => emitConversation(fresh,conversationId,'receipt',{conversationId,messageId,status:'delivered'}));
    return json(res,200,{messages:fresh.messages.filter(item=>item.conversationId===conversationId&&!item.deletedAt&&!(item.deletedForUserIds||[]).includes(user.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(item=>publicMessage(fresh,item))});
  }

  if (req.method === 'POST' && chatMessagesMatch) {
    const input = await body(req), conversationId = chatMessagesMatch[1], text = clean(input.text, 5000), files = Array.isArray(input.attachments) ? input.attachments.slice(0,3) : [];
    if (!text && !files.length) return json(res,400,{error:'Escriba un mensaje o seleccione un archivo'});
    try {
      const message = await mutateDb(db => {
        if (!chatParticipant(db,conversationId,user.id)) throw Object.assign(new Error('No pertenece a esta conversación'),{status:403});
        let totalSize=0; const prepared=files.map(file=>{const name=clean(file.name,180),mimeType=clean(file.mimeType,100)||'application/octet-stream',data=String(file.data||''),match=data.match(/^data:[^;]+;base64,(.+)$/);if(!name||!match)throw Object.assign(new Error('Archivo no válido'),{status:400});const size=Buffer.byteLength(match[1],'base64');totalSize+=size;if(size>5_000_000)throw Object.assign(new Error('Cada archivo debe pesar menos de 5 MB'),{status:413});return{name,mimeType,size,data:match[1]};});
        if(totalSize>8_000_000)throw Object.assign(new Error('Los archivos no pueden superar 8 MB en total'),{status:413});
        const now=new Date().toISOString(),next={id:crypto.randomUUID(),conversationId,senderId:user.id,type:text&&prepared.length?'mixed':prepared.length?'file':'text',text,replyToMessageId:null,forwardedFromMessageId:null,deletedAt:null,createdAt:now,updatedAt:now};db.messages.push(next);
        prepared.forEach(file=>db.attachments.push({id:crypto.randomUUID(),messageId:next.id,conversationId,...file,createdAt:now}));
        chatUserIds(db,conversationId).forEach(userId=>db.messageReceipts.push({id:crypto.randomUUID(),messageId:next.id,userId,deliveredAt:userId===user.id?now:null,readAt:userId===user.id?now:null}));
        const conversation=db.conversations.find(item=>item.id===conversationId);if(conversation)conversation.updatedAt=now;return next;
      });
      const db=readDb(),payload=publicMessage(db,message);emitConversation(db,conversationId,'message',payload);
      for(const recipientId of chatUserIds(db,conversationId).filter(id=>id!==user.id)) {
        const badgeCount=(db.messageReceipts||[]).filter(receipt=>receipt.userId===recipientId&&!receipt.readAt).length;
        await notifyUser(recipientId,{title:user.name,body:text||`Envió ${files.length===1?'un archivo':'archivos'}`,url:'/#chat',badgeCount});
      }
      return json(res,201,{message:payload});
    } catch(error){return json(res,error.status||500,{error:error.message});}
  }

  const chatMessageMatch=url.pathname.match(/^\/api\/chat\/messages\/([^/]+)$/);
  if(req.method==='DELETE'&&chatMessageMatch){
    try{
      const input=await body(req),scope=input.scope==='everyone'?'everyone':'me';
      const result=await mutateDb(db=>{const message=db.messages.find(item=>item.id===chatMessageMatch[1]&&!item.deletedAt);if(!message||!chatParticipant(db,message.conversationId,user.id))throw Object.assign(new Error('Mensaje no encontrado'),{status:404});if(scope==='everyone'){if(message.senderId!==user.id)throw Object.assign(new Error('Solo puede borrar para todos sus propios mensajes'),{status:403});message.deletedAt=new Date().toISOString();message.updatedAt=message.deletedAt;db.attachments=(db.attachments||[]).filter(item=>item.messageId!==message.id);db.messageReceipts=(db.messageReceipts||[]).filter(item=>item.messageId!==message.id);}else{message.deletedForUserIds||=[];if(!message.deletedForUserIds.includes(user.id))message.deletedForUserIds.push(user.id);db.messageReceipts=(db.messageReceipts||[]).filter(item=>!(item.messageId===message.id&&item.userId===user.id));}const conversation=db.conversations.find(item=>item.id===message.conversationId);if(conversation)conversation.updatedAt=new Date().toISOString();return{conversationId:message.conversationId,messageId:message.id,scope,userId:user.id};});
      const db=readDb();emitConversation(db,result.conversationId,'message-change',result);return json(res,200,{ok:true,scope});
    }catch(error){return json(res,error.status||500,{error:error.message});}
  }

  const forwardMatch=url.pathname.match(/^\/api\/chat\/messages\/([^/]+)\/forward$/);
  if(req.method==='POST'&&forwardMatch){
    const input=await body(req),targetConversationId=clean(input.conversationId,100);
    try{
      const forwarded=await mutateDb(db=>{const source=db.messages.find(item=>item.id===forwardMatch[1]&&!item.deletedAt&&!(item.deletedForUserIds||[]).includes(user.id));if(!source)throw Object.assign(new Error('Mensaje no encontrado'),{status:404});if(!chatParticipant(db,source.conversationId,user.id))throw Object.assign(new Error('No pertenece a la conversación original'),{status:403});if(!chatParticipant(db,targetConversationId,user.id))throw Object.assign(new Error('No pertenece a la conversación de destino'),{status:403});const sourceFiles=(db.attachments||[]).filter(item=>item.messageId===source.id);if(!source.text&&!sourceFiles.length)throw Object.assign(new Error('El mensaje no tiene contenido para reenviar'),{status:400});const now=new Date().toISOString(),next={id:crypto.randomUUID(),conversationId:targetConversationId,senderId:user.id,type:source.text&&sourceFiles.length?'mixed':sourceFiles.length?'file':'text',text:source.text||'',replyToMessageId:null,forwardedFromMessageId:source.id,deletedAt:null,createdAt:now,updatedAt:now};db.messages.push(next);sourceFiles.forEach(file=>db.attachments.push({...file,id:crypto.randomUUID(),messageId:next.id,conversationId:targetConversationId,createdAt:now}));chatUserIds(db,targetConversationId).forEach(userId=>db.messageReceipts.push({id:crypto.randomUUID(),messageId:next.id,userId,deliveredAt:userId===user.id?now:null,readAt:userId===user.id?now:null}));const conversation=db.conversations.find(item=>item.id===targetConversationId);if(conversation)conversation.updatedAt=now;return next;});
      const db=readDb(),payload=publicMessage(db,forwarded);emitConversation(db,targetConversationId,'message',payload);for(const recipientId of chatUserIds(db,targetConversationId).filter(id=>id!==user.id)){const badgeCount=db.messageReceipts.filter(receipt=>receipt.userId===recipientId&&!receipt.readAt).length;await notifyUser(recipientId,{title:user.name,body:'Reenvió un mensaje',url:`/#chat/${targetConversationId}`,badgeCount});}return json(res,201,{message:payload});
    }catch(error){return json(res,error.status||500,{error:error.message});}
  }

  const chatReadMatch=url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/read$/);
  if(req.method==='POST'&&chatReadMatch){const conversationId=chatReadMatch[1];try{const result=await mutateDb(db=>{const participant=chatParticipant(db,conversationId,user.id);if(!participant)throw Object.assign(new Error('No pertenece a esta conversación'),{status:403});const ids=db.messages.filter(item=>item.conversationId===conversationId&&!item.deletedAt&&!(item.deletedForUserIds||[]).includes(user.id)).map(item=>item.id),changed=[],now=new Date().toISOString();db.messageReceipts.filter(item=>item.userId===user.id&&ids.includes(item.messageId)&&!item.readAt).forEach(item=>{item.deliveredAt||=now;item.readAt=now;changed.push(item.messageId);});participant.lastReadAt=now;participant.lastReadMessageId=ids[ids.length-1]||null;return{messageIds:changed};});if(result.messageIds.length){const db=readDb();emitConversation(db,conversationId,'read',{conversationId,userId:user.id,messageIds:result.messageIds});}return json(res,200,{ok:true,deletedTasks:[]});}catch(error){return json(res,error.status||500,{error:error.message});}}

  const chatTypingMatch=url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/typing$/);
  if(req.method==='POST'&&chatTypingMatch){const input=await body(req),db=readDb(),conversationId=chatTypingMatch[1];if(!chatParticipant(db,conversationId,user.id))return json(res,403,{error:'No pertenece a esta conversación'});chatUserIds(db,conversationId).filter(id=>id!==user.id).forEach(id=>emitChat(id,'typing',{conversationId,userId:user.id,name:user.name,typing:input.typing===true}));return json(res,200,{ok:true});}

  const attachmentMatch=url.pathname.match(/^\/api\/chat\/attachments\/([^/]+)$/);
  if(req.method==='GET'&&attachmentMatch){const db=readDb(),attachment=db.attachments.find(item=>item.id===attachmentMatch[1]);if(!attachment)return json(res,404,{error:'Archivo no encontrado'});if(!chatParticipant(db,attachment.conversationId,user.id)&&user.role!=='admin')return json(res,403,{error:'No pertenece a esta conversación'});const file=Buffer.from(attachment.data,'base64');res.writeHead(200,{'Content-Type':attachment.mimeType,'Content-Length':file.length,'Content-Disposition':`${attachment.mimeType.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,'Cache-Control':'private, max-age=3600'});return res.end(file);}
  if(req.method==='DELETE'&&attachmentMatch){try{const result=await mutateDb(db=>{const attachment=(db.attachments||[]).find(item=>item.id===attachmentMatch[1]);if(!attachment)throw Object.assign(new Error('Adjunto no encontrado'),{status:404});const message=db.messages.find(item=>item.id===attachment.messageId&&!item.deletedAt);if(!message)throw Object.assign(new Error('Mensaje no encontrado'),{status:404});if(message.senderId!==user.id)throw Object.assign(new Error('Solo puede borrar sus propios adjuntos'),{status:403});db.attachments=db.attachments.filter(item=>item.id!==attachment.id);if(!message.text&&!db.attachments.some(item=>item.messageId===message.id)){message.deletedAt=new Date().toISOString();message.updatedAt=message.deletedAt;db.messageReceipts=db.messageReceipts.filter(item=>item.messageId!==message.id);}return{conversationId:attachment.conversationId,messageId:message.id};});const db=readDb();emitConversation(db,result.conversationId,'message-change',result);return json(res,200,{ok:true});}catch(error){return json(res,error.status||500,{error:error.message});}}

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    await purgeExpiredTasks();
    const db = readDb();
    const tasks = db.tasks.map(task => ({
      ...task,
      notes: Array.isArray(task.notes) ? task.notes : [],
      assigneeName: db.users.find(item => item.id === task.assigneeId)?.name || 'Usuario eliminado',
      creatorName: db.users.find(item => item.id === task.creatorId)?.name || 'Usuario eliminado'
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, { tasks });
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const input = await body(req);
    const rawTitle = String(input.title || '').trim(), title = clean(rawTitle, 50), description = clean(input.description, 2000), assigneeId = clean(input.assigneeId, 100), dueDate = clean(input.dueDate, 10);
    if (!title || rawTitle.length > 50 || !assigneeId || !validDate(dueDate)) return json(res, 400, { error: 'Título de hasta 50 caracteres, empleado asignado y fecha de terminación válida son obligatorios' });
    try {
      const task = await mutateDb(db => {
        if (!db.users.some(item => item.id === assigneeId && item.active)) throw Object.assign(new Error('El empleado asignado no existe'), { status: 400 });
        const now = new Date().toISOString();
        const next = { id: crypto.randomUUID(), title, description, notes: [], creatorId: user.id, assigneeId, dueDate, progress: 0, acknowledgedAt: null, createdAt: now, updatedAt: now, completedAt: null };
        db.tasks.push(next); return next;
      });
      await sendDirectSystemMessage(user, task.assigneeId, assignmentMessage(task,user.name), `${task.title} · Finaliza ${task.dueDate}`);
      return json(res, 201, { task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'PATCH' && taskMatch) {
    const input = await body(req), taskId = taskMatch[1];
    const rawTitle = String(input.title || '').trim(), title = clean(rawTitle, 50), assigneeId = clean(input.assigneeId, 100), dueDate = clean(input.dueDate, 10);
    if (!title || rawTitle.length > 50 || !assigneeId || !validDate(dueDate)) return json(res, 400, { error: 'Título de hasta 50 caracteres, empleado asignado y fecha de terminación válida son obligatorios' });
    try {
      const result = await mutateDb(db => {
        const found = db.tasks.find(item => item.id === taskId);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.creatorId !== user.id && user.role !== 'admin') throw Object.assign(new Error('Solo quien creó la tarea o el administrador pueden editarla'), { status: 403 });
        if (!db.users.some(item => item.id === assigneeId && item.active)) throw Object.assign(new Error('El empleado asignado no existe'), { status: 400 });
        const reassigned = found.assigneeId !== assigneeId;
        found.title = title; found.assigneeId = assigneeId; found.dueDate = dueDate; found.updatedAt = new Date().toISOString();
        if (reassigned) found.acknowledgedAt = null;
        return { task: found, reassigned };
      });
      if (result.reassigned) await sendDirectSystemMessage(user, result.task.assigneeId, assignmentMessage(result.task,user.name,'Tarea reasignada'), `${result.task.title} · Finaliza ${result.task.dueDate}`);
      return json(res, 200, { task: result.task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'DELETE' && taskMatch) {
    if (user.role !== 'admin') return json(res,403,{error:'Solo el administrador puede eliminar tareas'});
    try { await mutateDb(db=>{const index=db.tasks.findIndex(item=>item.id===taskMatch[1]);if(index<0)throw Object.assign(new Error('Tarea no encontrada'),{status:404});db.tasks.splice(index,1);});return json(res,200,{ok:true}); }
    catch(error){return json(res,error.status||500,{error:error.message});}
  }

  const noteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/notes$/);
  if (req.method === 'POST' && noteMatch) {
    const input = await body(req), text = clean(input.text, 2000);
    if (!text) return json(res, 400, { error: 'La anotación no puede estar vacía' });
    try {
      const task = await mutateDb(db => {
        const found = db.tasks.find(item => item.id === noteMatch[1]);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.creatorId !== user.id && found.assigneeId !== user.id) throw Object.assign(new Error('Solo el creador o el empleado asignado pueden agregar anotaciones'), { status: 403 });
        found.notes ||= []; found.notes.push({ text, createdAt: new Date().toISOString() }); found.updatedAt = new Date().toISOString();
        return found;
      });
      return json(res, 201, { task });
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
      const result = await mutateDb(db => {
        const found = db.tasks.find(item => item.id === taskId);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.assigneeId !== user.id) throw Object.assign(new Error('Solo la persona asignada puede cambiar el estado'), { status: 403 });
        const justCompleted = found.progress !== 100 && progress === 100;
        found.progress = progress; found.updatedAt = new Date().toISOString(); found.completedAt = progress === 100 ? (found.completedAt || found.updatedAt) : null;
        return { task: found, justCompleted };
      });
      if(result.justCompleted)await sendDirectSystemMessage(user,result.task.creatorId,completionMessage(result.task,user.name),`${result.task.title} fue finalizada`,{systemType:'task_completed',relatedTaskType:'employee',relatedTaskId:result.task.id});
      return json(res, 200, { task: result.task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/machines') {
    const db = readDb();
    const machines = (db.machines || []).map(machine => ({
      ...machine,
      responsibleName: db.users.find(item => item.id === machine.responsibleId)?.name || 'Usuario eliminado'
    })).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    return json(res, 200, { machines });
  }

  if (req.method === 'POST' && url.pathname === '/api/machines') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede crear maquinarias' });
    const input = await body(req), name = clean(input.name, 100), responsibleId = clean(input.responsibleId, 100);
    if (!name || !responsibleId) return json(res, 400, { error: 'Nombre y responsable son obligatorios' });
    try {
      const machine = await mutateDb(db => {
        if (!db.users.some(item => item.id === responsibleId && item.active)) throw Object.assign(new Error('El responsable no existe'), { status: 400 });
        if ((db.machines || []).some(item => item.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('Ya existe una maquinaria con ese nombre'), { status: 409 });
        const now = new Date().toISOString(), next = { id: crypto.randomUUID(), name, responsibleId, createdAt: now, updatedAt: now };
        db.machines ||= []; db.machines.push(next); return next;
      });
      return json(res, 201, { machine });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const machineMatch = url.pathname.match(/^\/api\/machines\/([^/]+)$/);
  if (req.method === 'PATCH' && machineMatch) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede editar maquinarias' });
    const input = await body(req), name = clean(input.name, 100), responsibleId = clean(input.responsibleId, 100), machineId = machineMatch[1];
    if (!name || !responsibleId) return json(res, 400, { error: 'Nombre y responsable son obligatorios' });
    try {
      const result = await mutateDb(db => {
        const found = (db.machines || []).find(item => item.id === machineId);
        if (!found) throw Object.assign(new Error('Maquinaria no encontrada'), { status: 404 });
        if (!db.users.some(item => item.id === responsibleId && item.active)) throw Object.assign(new Error('El responsable no existe'), { status: 400 });
        if (db.machines.some(item => item.id !== machineId && item.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('Ya existe una maquinaria con ese nombre'), { status: 409 });
        const changed = found.responsibleId !== responsibleId;
        found.name = name; found.responsibleId = responsibleId; found.updatedAt = new Date().toISOString();
        if (changed) (db.machineTasks || []).filter(task => task.machineId === machineId && task.progress < 100).forEach(task => { task.assigneeId = responsibleId; task.acknowledgedAt = null; task.updatedAt = found.updatedAt; });
        return { machine: found, changed };
      });
      if (result.changed) await notifyUser(responsibleId, { title: 'Maquinaria asignada', body: `Ahora eres responsable de ${result.machine.name}`, url: '/' });
      return json(res, 200, { machine: result.machine });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'DELETE' && machineMatch) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador puede eliminar maquinarias' });
    try {
      await mutateDb(db => {
        const index = (db.machines || []).findIndex(item => item.id === machineMatch[1]);
        if (index < 0) throw Object.assign(new Error('Maquinaria no encontrada'), { status: 404 });
        db.machines.splice(index, 1); db.machineTasks = (db.machineTasks || []).filter(task => task.machineId !== machineMatch[1]);
      });
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/machine-tasks') {
    const db = readDb();
    const machineTasks = (db.machineTasks || []).map(task => ({ ...task, notes: Array.isArray(task.notes) ? task.notes : [], machineName: db.machines.find(item => item.id === task.machineId)?.name || 'Maquinaria eliminada', creatorName: db.users.find(item => item.id === task.creatorId)?.name || 'Usuario eliminado', assigneeName: db.users.find(item => item.id === task.assigneeId)?.name || 'Usuario eliminado' })).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, { machineTasks });
  }

  if (req.method === 'POST' && url.pathname === '/api/machine-tasks') {
    const input = await body(req), rawTitle = String(input.title || '').trim(), title = clean(rawTitle, 50), description = clean(input.description, 2000), machineId = clean(input.machineId, 100), dueDate = clean(input.dueDate, 10);
    if (!title || rawTitle.length > 50 || !machineId || !validDate(dueDate)) return json(res, 400, { error: 'Maquinaria, título de hasta 50 caracteres y fecha válida son obligatorios' });
    try {
      const task = await mutateDb(db => {
        const machine = (db.machines || []).find(item => item.id === machineId);
        if (!machine) throw Object.assign(new Error('Maquinaria no encontrada'), { status: 404 });
        if (!db.users.some(item => item.id === machine.responsibleId && item.active)) throw Object.assign(new Error('La maquinaria no tiene un responsable activo'), { status: 400 });
        const now = new Date().toISOString(), next = { id: crypto.randomUUID(), machineId, title, description, notes: [], creatorId: user.id, assigneeId: machine.responsibleId, dueDate, progress: 0, acknowledgedAt: null, createdAt: now, updatedAt: now, completedAt: null };
        db.machineTasks ||= []; db.machineTasks.push(next); return next;
      });
      const machineName=readDb().machines.find(item=>item.id===task.machineId)?.name||'Maquinaria';
      await sendDirectSystemMessage(user,task.assigneeId,assignmentMessage(task,user.name,`Nueva tarea de maquinaria: ${machineName}`),`${machineName}: ${task.title} · Finaliza ${task.dueDate}`);
      return json(res, 201, { task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  const machineTaskMatch = url.pathname.match(/^\/api\/machine-tasks\/([^/]+)$/);
  if (req.method === 'PATCH' && machineTaskMatch) {
    const input = await body(req), rawTitle = String(input.title || '').trim(), title = clean(rawTitle, 50), description = clean(input.description, 2000), dueDate = clean(input.dueDate, 10);
    if (!title || rawTitle.length > 50 || !validDate(dueDate)) return json(res, 400, { error: 'Título de hasta 50 caracteres y fecha válida son obligatorios' });
    try {
      const task = await mutateDb(db => {
        const found = (db.machineTasks || []).find(item => item.id === machineTaskMatch[1]);
        if (!found) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
        if (found.creatorId !== user.id && user.role !== 'admin') throw Object.assign(new Error('Solo el creador o el administrador pueden modificar la tarea'), { status: 403 });
        found.title = title; found.description = description; found.dueDate = dueDate; found.updatedAt = new Date().toISOString();
        return found;
      });
      return json(res, 200, { task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
  if(req.method==='DELETE'&&machineTaskMatch){if(user.role!=='admin')return json(res,403,{error:'Solo el administrador puede eliminar tareas de maquinaria'});try{await mutateDb(db=>{const index=(db.machineTasks||[]).findIndex(item=>item.id===machineTaskMatch[1]);if(index<0)throw Object.assign(new Error('Tarea no encontrada'),{status:404});db.machineTasks.splice(index,1);});return json(res,200,{ok:true});}catch(error){return json(res,error.status||500,{error:error.message});}}

  const machineTaskAction = url.pathname.match(/^\/api\/machine-tasks\/([^/]+)\/(acknowledge|status|notes)$/);
  if (machineTaskAction && req.method === 'POST' && machineTaskAction[2] === 'acknowledge') {
    try { const task = await mutateDb(db => { const found=(db.machineTasks||[]).find(item=>item.id===machineTaskAction[1]); if(!found)throw Object.assign(new Error('Tarea no encontrada'),{status:404}); if(found.assigneeId!==user.id)throw Object.assign(new Error('Solo el responsable puede confirmar la lectura'),{status:403}); found.acknowledgedAt ||= new Date().toISOString(); return found; }); return json(res,200,{task}); }
    catch(error){return json(res,error.status||500,{error:error.message});}
  }
  if (machineTaskAction && req.method === 'PATCH' && machineTaskAction[2] === 'status') {
    const input=await body(req),progress=Number(input.progress); if(progress!==100)return json(res,400,{error:'El único estado permitido es Finalizada'});
    try { const result=await mutateDb(db=>{const found=(db.machineTasks||[]).find(item=>item.id===machineTaskAction[1]);if(!found)throw Object.assign(new Error('Tarea no encontrada'),{status:404});if(found.assigneeId!==user.id)throw Object.assign(new Error('Solo el responsable puede cambiar el estado'),{status:403});const justCompleted=found.progress!==100;found.progress=progress;found.updatedAt=new Date().toISOString();found.completedAt ||= found.updatedAt;return{task:found,justCompleted};});if(result.justCompleted)await sendDirectSystemMessage(user,result.task.creatorId,completionMessage(result.task,user.name,'Tarea de maquinaria finalizada'),`${result.task.title} fue finalizada`,{systemType:'task_completed',relatedTaskType:'machine',relatedTaskId:result.task.id});return json(res,200,{task:result.task}); }
    catch(error){return json(res,error.status||500,{error:error.message});}
  }
  if (machineTaskAction && req.method === 'POST' && machineTaskAction[2] === 'notes') {
    const input=await body(req),text=clean(input.text,2000);if(!text)return json(res,400,{error:'La anotación no puede estar vacía'});
    try { const task=await mutateDb(db=>{const found=(db.machineTasks||[]).find(item=>item.id===machineTaskAction[1]);if(!found)throw Object.assign(new Error('Tarea no encontrada'),{status:404});if(found.creatorId!==user.id&&found.assigneeId!==user.id)throw Object.assign(new Error('Solo el creador o el responsable pueden agregar anotaciones'),{status:403});found.notes||=[];found.notes.push({text,createdAt:new Date().toISOString()});found.updatedAt=new Date().toISOString();return found;});return json(res,201,{task}); }
    catch(error){return json(res,error.status||500,{error:error.message});}
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
purgeExpiredTasks().catch(error => console.error('No se pudo depurar tareas:', error.message));
setInterval(() => purgeExpiredTasks().catch(error => console.error('No se pudo depurar tareas:', error.message)), 60 * 60 * 1000).unref();

module.exports = { server, readDb, STATUSES };
