'use strict';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (v, n = 200) => String(v || '').trim().slice(0, n);
function point(p, required = false) {
  if (p == null) { if (required) fail('Indica la ubicación del cliente'); return null; }
  if (typeof p.latitude !== 'number' || typeof p.longitude !== 'number' || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) fail('Coordenadas inválidas');
  return { latitude: p.latitude, longitude: p.longitude, accuracy: typeof p.accuracy === 'number' && Number.isFinite(p.accuracy) && p.accuracy >= 0 ? p.accuracy : null };
}
function timestamp(v) {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || Date.parse(v) > Date.now() + 300000) fail('Fecha de registro inválida; revisa el reloj del celular');
  return new Date(v).toISOString();
}
function clients(db) {
  const locations = db.customerLocations || {};
  return [...(db.companies || []).map(c => ({ id: c.id, name: c.name, address: c.address || '', city: c.city || '', phone: c.phone || '', contact: '', point: locations[c.id]?.point || null, source: 'company' })), ...(db.fieldClients || [])];
}
function applyOperation(db, user, op) {
  db.fieldClients ||= []; db.fieldVisits ||= []; db.customerLocations ||= {}; db.fieldOperations ||= [];
  if (!op || !/^[a-zA-Z0-9-]{16,100}$/.test(op.id || '')) fail('Identificador inválido');
  if (db.fieldOperations.some(o => o.id === op.id && o.userId === user.id)) return;
  const input = op.data || {}, now = new Date().toISOString();
  if (op.type === 'client') {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(input.id || '') || !text(input.name)) fail('Nombre de cliente obligatorio');
    if (clients(db).some(c => c.id === input.id)) fail('Ya existe ese identificador', 409);
    db.fieldClients.push({ id: input.id, name: text(input.name), address: text(input.address, 400), city: text(input.city), contact: text(input.contact), phone: text(input.phone, 60), point: point(input.point, true), createdBy: user.id, createdAt: timestamp(input.createdAt), syncedAt: now, source: 'field' });
  } else if (op.type === 'location') {
    const client = clients(db).find(c => c.id === input.clientId);
    if (!client) fail('Cliente no encontrado', 404);
    if (client.point && user.role !== 'admin') fail('Solo un administrador puede corregir una ubicación existente', 403);
    const location = point(input.point, true);
    if (client.source === 'company') db.customerLocations[client.id] = { point: location, updatedBy: user.id, updatedAt: now };
    else Object.assign(db.fieldClients.find(c => c.id === client.id), { point: location, updatedBy: user.id, updatedAt: now });
  } else if (op.type === 'arrival') {
    if (!clients(db).some(c => c.id === input.clientId)) fail('Cliente no encontrado', 404);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(input.id || '') || db.fieldVisits.some(v => v.id === input.id)) fail('Identificador de visita inválido o duplicado', 409);
    if (db.fieldVisits.some(v => v.userId === user.id && !v.endedAt)) fail('Finaliza tu visita anterior primero', 409);
    db.fieldVisits.push({ id: input.id, clientId: input.clientId, userId: user.id, arrivedAt: timestamp(input.arrivedAt), point: point(input.point), reason: text(input.reason, 500), endedAt: null, result: '', note: '', syncedAt: now });
  } else if (op.type === 'finish') {
    const visit = db.fieldVisits.find(v => v.id === input.id);
    if (!visit) fail('Visita no encontrada', 404);
    if (visit.userId !== user.id) fail('Solo el vendedor que inició la visita puede finalizarla', 403);
    if (visit.endedAt) fail('La visita ya terminó', 409);
    const endedAt = timestamp(input.endedAt);
    if (endedAt < visit.arrivedAt) fail('La salida no puede ser anterior a la llegada');
    if (!['Pedido realizado', 'Sin pedido', 'Cliente cerrado', 'Volver otro día'].includes(input.result)) fail('Selecciona el resultado');
    Object.assign(visit, { endedAt, result: input.result, note: text(input.note, 1000), finishedSyncedAt: now });
  } else fail('Operación desconocida');
  db.fieldOperations.push({ id: op.id, userId: user.id, at: now });
}
module.exports = { applyOperation, clients, createHandler: ({ readDb, mutateDb, body, json }) => async (req, res, url, user) => {
  if (!url.pathname.startsWith('/api/field/')) return false;
  if (!['seller', 'admin'].includes(user.role)) { json(res, 403, { error: 'Acceso reservado a vendedores y administradores' }); return true; }
  if (req.method === 'GET' && url.pathname === '/api/field/data') {
    const db = readDb(), visits = db.fieldVisits || [];
    const lastVisits = {};
    for (const v of [...visits].sort((a,b) => a.arrivedAt.localeCompare(b.arrivedAt))) lastVisits[v.clientId] = { arrivedAt: v.arrivedAt, seller: db.users.find(u => u.id === v.userId)?.name || 'Vendedor' };
    json(res, 200, { clients: clients(db), visits: visits.filter(v => user.role === 'admin' || v.userId === user.id), lastVisits, sellers: db.users.filter(u => ['seller','admin'].includes(u.role)).map(u => ({ id: u.id, name: u.name })), downloadedAt: new Date().toISOString() });
  } else if (req.method === 'POST' && url.pathname === '/api/field/sync') {
    const op = await body(req);
    await mutateDb(db => applyOperation(db, user, op));
    json(res, 200, { ok: true, operationId: op.id });
  } else json(res, 404, { error: 'Ruta no encontrada' });
  return true;
} };
