'use strict';
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function createOrder(db, user, input) {
  if (user.role !== 'client') fail('Solo los clientes pueden enviar pedidos', 403);
  if (typeof input.requestId !== 'string' || !/^[\w-]{16,100}$/.test(input.requestId)) fail('Identificador de pedido no válido');
  db.productOrders ||= [];
  const previous = db.productOrders.find(order => order.clientId === user.id && order.requestId === input.requestId);
  if (previous) return { order: previous, duplicate: true };
  const client = db.users.find(item => item.id === user.id && item.active && item.role === 'client');
  const group = client && db.conversations.find(item => item.type === 'group' && item.companyId === client.companyId && item.settings?.clientGroup && db.conversationParticipants.some(p => p.conversationId === item.id && p.userId === client.id));
  if (!group) fail('El cliente no tiene un grupo de chat asignado. Contacte al administrador.', 409);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 2000) fail('Seleccione entre 1 y 2000 productos');
  const seen = new Set();
  const items = input.items.map(line => {
    if (!line || seen.has(line.productId)) fail('Producto repetido o no válido');
    seen.add(line.productId);
    const product = db.products.find(p => p.id === line.productId);
    if (!product) fail('Un producto ya no está disponible. Regrese al listado.', 409);
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 1000000 || Math.abs(line.quantity * 1000 - Math.round(line.quantity * 1000)) > 0.000001) fail('La cantidad debe ser positiva, con un máximo de tres decimales');
    const unpriced = product.price3 == null || product.price3 === '';
    if (!unpriced && (typeof product.price3 !== 'number' || !Number.isFinite(product.price3) || product.price3 < 0)) fail(`El producto ${product.product} tiene un precio inválido`, 409);
    const price = unpriced ? null : product.price3;
    if ((line.price3 == null || line.price3 === '' ? null : line.price3) !== price) fail('Cambió un precio. Regrese al listado y revise el pedido nuevamente.', 409);
    return { productId: product.id, product: product.product, quantity: line.quantity, price3: price, amount: unpriced ? null : Math.round(line.quantity * price * 100) / 100 };
  });
  const now = new Date().toISOString(), id = crypto.randomUUID();
  const order = { id, number: `PED-${now.slice(0,10).replaceAll('-','')}-${id.slice(0,8).toUpperCase()}`, requestId: input.requestId, clientId: client.id, clientName: client.name, clientPhone: client.phone || '', companyId: client.companyId, conversationId: group.id, items, createdAt: now };
  Object.assign(order, { status: 'sent', revision: 1, note: '', updatedAt: now, history: [] });
  snapshot(order, user, 'sent');
  const message = { id: crypto.randomUUID(), orderId: id, conversationId: group.id, senderId: client.id, type: 'text', text: `Pedido ${order.number} · ${client.name}`, replyToMessageId: null, forwardedFromMessageId: null, deletedAt: null, createdAt: now, updatedAt: now };
  order.messageId = message.id;
  db.messages.push(message);
  db.conversationParticipants.filter(p => p.conversationId === group.id).forEach(p => db.messageReceipts.push({ id: crypto.randomUUID(), messageId: message.id, userId: p.userId, deliveredAt: p.userId === client.id ? now : null, readAt: p.userId === client.id ? now : null }));
  group.updatedAt = now;
  db.productOrders.push(order);
  return { order, duplicate: false };
}

function buildWorkbook(order) {
  const rows = [[`Cliente: ${order.clientName} | Teléfono: ${order.clientPhone || 'No registrado'}`], ['PEDIDO'], ['Número', order.number], ['Fecha', order.createdAt.replace('T', ' ').slice(0,19) + ' UTC'], [], ['Producto', 'Cantidad', 'Precio unitario (precio3)', 'Importe']];
  order.items.forEach((item, i) => rows.push([item.product, item.quantity, item.price3 == null ? 'Por confirmar' : item.price3, { t: item.price3 == null ? 's' : 'n', f: `IF(ISNUMBER(C${i+7}),ROUND(B${i+7}*C${i+7},2),"Por confirmar")`, v: item.amount == null ? 'Por confirmar' : item.amount }]));
  rows.push(['TOTAL', null, null, { t: 'n', f: `SUM(D7:D${rows.length})`, v: Math.round(order.items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100 }], [], ['Observaciones'], ['Puede editar cantidades y precios; los importes se recalculan en Excel.']);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if(order.items.some(item=>item.price3==null)){sheet['A'+(7+order.items.length)]={t:'s',v:'SUBTOTAL CON PRECIO'};sheet['A'+rows.length]={t:'s',v:'Hay precios por confirmar. El subtotal no incluye esos artículos; al completar precios se recalculan los importes.'};}
  sheet['!cols'] = [{ wch: 58 }, { wch: 26 }, { wch: 27 }, { wch: 18 }];
  sheet['!merges'] = [0,1,rows.length-2,rows.length-1].map(r => ({ s: { r, c: 0 }, e: { r, c: 3 } }));
  sheet['!rows'] = rows.map((_, i) => ({ hpt: i < 2 ? 28 : 22 }));
  for (let row = 7; row <= 7 + order.items.length; row++) for (const col of ['C','D']) if (sheet[col+row]) sheet[col+row].z = '#,##0.00';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Pedido');
  book.Workbook = { CalcPr: { fullCalcOnLoad: true } };
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
function snapshot(order, user, action) {
  order.history.push({ revision: order.revision, status: order.status, action, userId: user.id, userName: user.name, at: order.updatedAt, note: order.note, items: order.items.map(item => ({ ...item })) });
}
function getOrder(db, user, id) {
  const order = (db.productOrders || []).find(item => item.id === id);
  if (!order) fail('Pedido no encontrado', 404);
  if (!db.conversationParticipants.some(p => p.conversationId === order.conversationId && p.userId === user.id) && user.role !== 'admin') fail('No pertenece al chat de este pedido', 403);
  return order;
}
function publicOrder(order) {
  const { history, operations, ...visible } = order;
  return visible;
}
function updateOrder(db, user, id, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Acción no válida');
  const order = getOrder(db, user, id);
  if (!db.conversationParticipants.some(p => p.conversationId === order.conversationId && p.userId === user.id)) fail('La supervisión es de solo lectura', 403);
  const customer = user.role === 'client' && user.id === order.clientId;
  const internal = ['admin', 'employee', 'seller'].includes(user.role);
  const action = input.action;
  if (!(customer && ['approve', 'requestChanges'].includes(action)) && !(internal && ['saveQuote', 'sendQuote'].includes(action))) fail('No puede realizar esta acción', 403);
  if (typeof input.actionId !== 'string' || !/^[\w-]{16,100}$/.test(input.actionId)) fail('Identificador de acción no válido');
  if ((order.operations || []).some(op => op.id === input.actionId && op.userId === user.id)) return { order, duplicate: true };
  if (!order.revision) fail('Este pedido antiguo se gestiona con su archivo adjunto', 409);
  if (input.revision !== order.revision) fail('Hay una versión más reciente. Actualice el pedido antes de continuar.', 409);
  if (order.status === 'approved') fail('El pedido aprobado no se puede modificar', 409);
  if (customer && order.status !== 'quoted') fail('El pedido todavía no está pendiente de aprobación', 409);
  if (internal && order.status === 'quoted') fail('Espere la respuesta del cliente antes de cambiar su cotización', 409);
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > 2000)) fail('Las observaciones admiten hasta 2000 caracteres');
  let items = order.items.map(item => ({ ...item }));
  if (action !== 'approve') {
    if (!Array.isArray(input.items) || input.items.length !== items.length) fail('Revise los productos del pedido');
    items = items.map((item, index) => {
      const line = input.items[index];
      if (!line || line.productId !== item.productId) fail('No puede sustituir los productos del pedido');
      if (customer) {
        const q = line.quantity;
        if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || q > 1000000 || Math.abs(q * 1000 - Math.round(q * 1000)) > 0.000001) fail('Cantidad inválida: use hasta tres decimales');
        if (line.price3 !== item.price3) fail('El cliente no puede cambiar precios', 403);
        item.quantity = q;
      } else {
        if (line.quantity !== item.quantity) fail('Las cantidades las modifica el cliente');
        const p = line.price3;
        if (p !== null && (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1000000000 || Math.abs(p * 100 - Math.round(p * 100)) > 0.00001)) fail('Precio inválido: use hasta dos decimales');
        item.price3 = p;
      }
      item.amount = item.price3 == null ? null : Math.round(item.quantity * item.price3 * 100) / 100;
      return item;
    });
  }
  if (['sendQuote', 'approve'].includes(action) && items.some(item => item.price3 == null)) fail('Complete todos los precios antes de enviar la cotización');
  if (action === 'requestChanges' && !String(input.note || '').trim() && items.every((item, i) => item.quantity === order.items[i].quantity)) fail('Cambie una cantidad o indique los cambios que necesita');
  order.items = items;
  if (action !== 'approve') order.note = String(input.note || '').trim();
  order.status = { saveQuote: 'quoting', sendQuote: 'quoted', approve: 'approved', requestChanges: 'changes_requested' }[action];
  order.revision++;
  order.updatedAt = new Date().toISOString();
  if (action === 'approve') { order.approvedAt = order.updatedAt; order.approvedBy = user.id; }
  snapshot(order, user, action);
  (order.operations ||= []).push({ id: input.actionId, userId: user.id });
  const original = db.messages.find(m => m.id === order.messageId);
  if (original) original.updatedAt = order.updatedAt;
  let message;
  if (action !== 'saveQuote') {
    const label = { sendQuote: 'Cotización lista para aprobar', approve: 'Pedido aprobado por el cliente', requestChanges: 'El cliente solicita cambios' }[action];
    message = { id: crypto.randomUUID(), orderRefId: order.id, conversationId: order.conversationId, senderId: user.id, type: 'text', text: `${order.number}: ${label} · versión ${order.revision}`, createdAt: order.updatedAt, updatedAt: order.updatedAt };
    db.messages.push(message);
    db.conversationParticipants.filter(p => p.conversationId === order.conversationId).forEach(p => db.messageReceipts.push({ id: crypto.randomUUID(), messageId: message.id, userId: p.userId, deliveredAt: p.userId === user.id ? order.updatedAt : null, readAt: p.userId === user.id ? order.updatedAt : null }));
  }
  db.conversations.find(c => c.id === order.conversationId).updatedAt = order.updatedAt;
  return { order, message, duplicate: false };
}
module.exports = { createOrder, buildWorkbook, updateOrder, getOrder, publicOrder };
