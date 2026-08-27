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
const TASK_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const STATUSES = [0, 25, 50, 75, 100];
const ROLES = ['admin', 'employee'];
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
    tasks: [],
    machines: [],
    machineTasks: [],
    conversations: [],
    conversationParticipants: [],
    messages: [],
    attachments: [],
    messageReceipts: [],
    calls: []
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
  for (const collection of ['conversations', 'conversationParticipants', 'messages', 'attachments', 'messageReceipts', 'calls']) {
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
  return { id: user.id, name: user.name, username: user.username, role: user.role, active: user.active };
}

function clean(value, max = 200) { return String(value || '').trim().slice(0, max); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')); }
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
  return { ...message, senderName: db.users.find(item => item.id === message.senderId)?.name || 'Usuario eliminado', attachments: (db.attachments || []).filter(item => item.messageId === message.id).map(publicAttachment), delivered: receipts.filter(item => item.userId !== message.senderId).every(item => item.deliveredAt), read: receipts.filter(item => item.userId !== message.senderId).every(item => item.readAt) };
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
  const cutoff = Date.now() - TASK_RETENTION_MS;
  const hasExpired = readDb().tasks.some(task => task.progress === 100 && task.completedAt && new Date(task.completedAt).getTime() <= cutoff);
  if (hasExpired) await mutateDb(db => { db.tasks = db.tasks.filter(task => !(task.progress === 100 && task.completedAt && new Date(task.completedAt).getTime() <= cutoff)); });
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
    return json(res, 200, { users: (user.role === 'admin' ? allUsers : allUsers.filter(item => item.active)).map(publicUser).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })) });
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
    return json(res, 200, { members: readDb().users.filter(item => item.active && item.id !== user.id).map(publicUser).sort((a,b)=>a.name.localeCompare(b.name,'es',{sensitivity:'base'})) });
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/conversations') {
    const db = readDb(), memberships = (db.conversationParticipants || []).filter(item => item.userId === user.id);
    const conversations = memberships.map(membership => {
      const conversation = db.conversations.find(item => item.id === membership.conversationId);
      if (!conversation) return null;
      const participantIds = chatUserIds(db, conversation.id), otherId = participantIds.find(id => id !== user.id), other = db.users.find(item => item.id === otherId);
      const messages = db.messages.filter(item => item.conversationId === conversation.id && !item.deletedAt).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      const last = messages[messages.length - 1], unread = (db.messageReceipts || []).filter(item => item.userId === user.id && !item.readAt && messages.some(message => message.id === item.messageId)).length;
      return { id: conversation.id, type: conversation.type, user: other ? publicUser(other) : { id: otherId, name: 'Usuario eliminado', username: '', role: 'employee', active: false }, lastMessage: last ? publicMessage(db,last) : null, unread, updatedAt: last?.createdAt || conversation.updatedAt || conversation.createdAt, pinned: (conversation.pinnedBy || []).includes(user.id) };
    }).filter(Boolean).sort((a,b)=>(b.pinned-a.pinned)||b.updatedAt.localeCompare(a.updatedAt));
    return json(res, 200, { conversations, totalUnread: conversations.reduce((sum,item)=>sum+item.unread,0) });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/conversations') {
    const input = await body(req), otherId = clean(input.userId, 100);
    if (!otherId || otherId === user.id) return json(res, 400, { error: 'Seleccione otro usuario' });
    try {
      const conversation = await mutateDb(db => {
        if (!db.users.some(item => item.id === otherId && item.active)) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });
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
    if (!chatParticipant(db,conversationId,user.id)) return json(res,403,{error:'No pertenece a esta conversación'});
    const now = new Date().toISOString(), changed = [];
    await mutateDb(data => { (data.messageReceipts || []).filter(item => item.userId === user.id && !item.deliveredAt && data.messages.some(message => message.id === item.messageId && message.conversationId === conversationId)).forEach(item => { item.deliveredAt=now; changed.push(item.messageId); }); });
    const fresh = readDb(); changed.forEach(messageId => emitConversation(fresh,conversationId,'receipt',{conversationId,messageId,status:'delivered'}));
    return json(res,200,{messages:fresh.messages.filter(item=>item.conversationId===conversationId&&!item.deletedAt).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(item=>publicMessage(fresh,item))});
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
      for(const recipientId of chatUserIds(db,conversationId).filter(id=>id!==user.id)) await notifyUser(recipientId,{title:user.name,body:text||`Envió ${files.length===1?'un archivo':'archivos'}`,url:'/#chat'});
      return json(res,201,{message:payload});
    } catch(error){return json(res,error.status||500,{error:error.message});}
  }

  const chatReadMatch=url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/read$/);
  if(req.method==='POST'&&chatReadMatch){const conversationId=chatReadMatch[1];try{const messageIds=await mutateDb(db=>{const participant=chatParticipant(db,conversationId,user.id);if(!participant)throw Object.assign(new Error('No pertenece a esta conversación'),{status:403});const ids=db.messages.filter(item=>item.conversationId===conversationId).map(item=>item.id),changed=[],now=new Date().toISOString();db.messageReceipts.filter(item=>item.userId===user.id&&ids.includes(item.messageId)&&!item.readAt).forEach(item=>{item.deliveredAt||=now;item.readAt=now;changed.push(item.messageId);});participant.lastReadAt=now;participant.lastReadMessageId=ids[ids.length-1]||null;return changed;});if(messageIds.length){const db=readDb();emitConversation(db,conversationId,'read',{conversationId,userId:user.id,messageIds});}return json(res,200,{ok:true});}catch(error){return json(res,error.status||500,{error:error.message});}}

  const chatTypingMatch=url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/typing$/);
  if(req.method==='POST'&&chatTypingMatch){const input=await body(req),db=readDb(),conversationId=chatTypingMatch[1];if(!chatParticipant(db,conversationId,user.id))return json(res,403,{error:'No pertenece a esta conversación'});chatUserIds(db,conversationId).filter(id=>id!==user.id).forEach(id=>emitChat(id,'typing',{conversationId,userId:user.id,name:user.name,typing:input.typing===true}));return json(res,200,{ok:true});}

  const attachmentMatch=url.pathname.match(/^\/api\/chat\/attachments\/([^/]+)$/);
  if(req.method==='GET'&&attachmentMatch){const db=readDb(),attachment=db.attachments.find(item=>item.id===attachmentMatch[1]);if(!attachment)return json(res,404,{error:'Archivo no encontrado'});if(!chatParticipant(db,attachment.conversationId,user.id))return json(res,403,{error:'No pertenece a esta conversación'});const file=Buffer.from(attachment.data,'base64');res.writeHead(200,{'Content-Type':attachment.mimeType,'Content-Length':file.length,'Content-Disposition':`${attachment.mimeType.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,'Cache-Control':'private, max-age=3600'});return res.end(file);}

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
      await notifyUser(task.assigneeId, { title: 'Nueva tarea asignada', body: `${user.name}: ${task.title}`, url: '/' });
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
        if (found.creatorId !== user.id) throw Object.assign(new Error('Solo quien creó la tarea puede editarla'), { status: 403 });
        if (!db.users.some(item => item.id === assigneeId && item.active)) throw Object.assign(new Error('El empleado asignado no existe'), { status: 400 });
        const reassigned = found.assigneeId !== assigneeId;
        found.title = title; found.assigneeId = assigneeId; found.dueDate = dueDate; found.updatedAt = new Date().toISOString();
        if (reassigned) found.acknowledgedAt = null;
        return { task: found, reassigned };
      });
      if (result.reassigned) await notifyUser(result.task.assigneeId, { title: 'Tarea reasignada', body: `${user.name}: ${result.task.title}`, url: '/' });
      return json(res, 200, { task: result.task });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
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
      await notifyUser(task.assigneeId, { title: 'Nueva tarea de maquinaria', body: `${user.name}: ${task.title}`, url: '/' });
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

  const machineTaskAction = url.pathname.match(/^\/api\/machine-tasks\/([^/]+)\/(acknowledge|status|notes)$/);
  if (machineTaskAction && req.method === 'POST' && machineTaskAction[2] === 'acknowledge') {
    try { const task = await mutateDb(db => { const found=(db.machineTasks||[]).find(item=>item.id===machineTaskAction[1]); if(!found)throw Object.assign(new Error('Tarea no encontrada'),{status:404}); if(found.assigneeId!==user.id)throw Object.assign(new Error('Solo el responsable puede confirmar la lectura'),{status:403}); found.acknowledgedAt ||= new Date().toISOString(); return found; }); return json(res,200,{task}); }
    catch(error){return json(res,error.status||500,{error:error.message});}
  }
  if (machineTaskAction && req.method === 'PATCH' && machineTaskAction[2] === 'status') {
    const input=await body(req),progress=Number(input.progress); if(progress!==100)return json(res,400,{error:'El único estado permitido es Finalizada'});
    try { const task=await mutateDb(db=>{const found=(db.machineTasks||[]).find(item=>item.id===machineTaskAction[1]);if(!found)throw Object.assign(new Error('Tarea no encontrada'),{status:404});if(found.assigneeId!==user.id)throw Object.assign(new Error('Solo el responsable puede cambiar el estado'),{status:403});found.progress=progress;found.updatedAt=new Date().toISOString();found.completedAt=progress===100?found.updatedAt:null;return found;});return json(res,200,{task}); }
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
