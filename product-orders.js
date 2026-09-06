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
    if (typeof product.price3 !== 'number' || !Number.isFinite(product.price3) || product.price3 < 0) fail(`El producto ${product.product} no tiene precio3 válido`, 409);
    if (line.price3 !== product.price3) fail('Cambió un precio. Regrese al listado y revise el pedido nuevamente.', 409);
    return { productId: product.id, product: product.product, quantity: line.quantity, price3: product.price3, amount: Math.round(line.quantity * product.price3 * 100) / 100 };
  });
  const now = new Date().toISOString(), id = crypto.randomUUID();
  const order = { id, number: `PED-${now.slice(0,10).replaceAll('-','')}-${id.slice(0,8).toUpperCase()}`, requestId: input.requestId, clientId: client.id, clientName: client.name, clientPhone: client.phone || '', companyId: client.companyId, conversationId: group.id, items, createdAt: now };
  const workbook = buildWorkbook(order);
  if (workbook.length > 5000000) fail('El pedido supera el tamaño permitido', 413);
  const message = { id: crypto.randomUUID(), conversationId: group.id, senderId: client.id, type: 'mixed', text: `Pedido ${order.number} · ${client.name}\nExcel editable adjunto con ${items.length} productos.`, replyToMessageId: null, forwardedFromMessageId: null, deletedAt: null, createdAt: now, updatedAt: now };
  order.messageId = message.id;
  db.messages.push(message);
  db.attachments.push({ id: crypto.randomUUID(), messageId: message.id, conversationId: group.id, name: `${order.number}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: workbook.length, data: workbook.toString('base64'), createdAt: now });
  db.conversationParticipants.filter(p => p.conversationId === group.id).forEach(p => db.messageReceipts.push({ id: crypto.randomUUID(), messageId: message.id, userId: p.userId, deliveredAt: p.userId === client.id ? now : null, readAt: p.userId === client.id ? now : null }));
  group.updatedAt = now;
  db.productOrders.push(order);
  return { order, duplicate: false };
}

function buildWorkbook(order) {
  const rows = [[`Cliente: ${order.clientName} | Teléfono: ${order.clientPhone || 'No registrado'}`], ['PEDIDO'], ['Número', order.number], ['Fecha', order.createdAt.replace('T', ' ').slice(0,19) + ' UTC'], [], ['Producto', 'Cantidad', 'Precio unitario (precio3)', 'Importe']];
  order.items.forEach((item, i) => rows.push([item.product, item.quantity, item.price3, { t: 'n', f: `ROUND(B${i+7}*C${i+7},2)`, v: item.amount }]));
  rows.push(['TOTAL', null, null, { t: 'n', f: `SUM(D7:D${rows.length})`, v: Math.round(order.items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100 }], [], ['Observaciones'], ['Puede editar cantidades y precios; los importes se recalculan en Excel.']);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 58 }, { wch: 26 }, { wch: 27 }, { wch: 18 }];
  sheet['!merges'] = [0,1,rows.length-2,rows.length-1].map(r => ({ s: { r, c: 0 }, e: { r, c: 3 } }));
  sheet['!rows'] = rows.map((_, i) => ({ hpt: i < 2 ? 28 : 22 }));
  for (let row = 7; row <= 7 + order.items.length; row++) for (const col of ['C','D']) if (sheet[col+row]) sheet[col+row].z = '#,##0.00';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Pedido');
  book.Workbook = { CalcPr: { fullCalcOnLoad: true } };
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
module.exports = { createOrder, buildWorkbook };
