(() => {
  const states = new Map();
  const labels = { sent: 'Enviado', quoting: 'En cotización', quoted: 'Pendiente de aprobación', changes_requested: 'Cambios solicitados', approved: 'Aprobado' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => value == null ? 'Por cotizar' : Number(value).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let focus;
  const api = async (id, options = {}) => {
    const response = await fetch(`/api/products/orders/${encodeURIComponent(id)}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo actualizar el pedido');
    return data.order;
  };
  function reset(s, order) {
    s.order = order; s.base = order.revision; s.items = order.items.map(i => ({ ...i }));
    s.note = s.customer ? '' : order.note || ''; s.dirty = false; s.actionId = null; s.error = '';
  }
  function table(items, editable, customer) {
    return `<div class="chat-order-sheet"><table><colgroup><col style="width:40%"><col style="width:18%"><col style="width:20%"><col style="width:22%"></colgroup><thead><tr><th>Producto</th><th>Cantidad</th><th>Precio</th><th>Importe</th></tr></thead><tbody>${items.map((i, n) => `<tr><td>${esc(i.product)}</td><td>${editable && customer ? `<input aria-label="Cantidad de ${esc(i.product)}" data-line="${n}" data-field="quantity" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${esc(i.quantity)}">` : esc(i.quantity)}</td><td>${editable && !customer ? `<input aria-label="Precio de ${esc(i.product)}" data-line="${n}" data-field="price3" type="number" min="0" max="1000000000" step="0.01" inputmode="decimal" placeholder="Pendiente" value="${esc(i.price3)}">` : money(i.price3)}</td><td data-amount="${n}">${money(i.amount)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function total(items) {
    return `${items.some(i => i.price3 == null) ? 'Subtotal con precio' : 'Total'}: ${money(items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0))}`;
  }
  function content(s) {
    const o = s.order, conflict = s.base !== o.revision;
    const editable = !s.observer && !s.busy && !conflict && o.status !== 'approved' && (s.customer ? o.status === 'quoted' : s.internal && o.status !== 'quoted');
    return `<header><b>${esc(o.number)}</b><span class="order-state ${esc(o.status)}">${labels[o.status] || 'Pedido anterior'}</span></header><small>Versión ${o.revision} · ${esc(o.clientName)}</small>${o.note ? `<p class="chat-order-note">Observaciones: ${esc(o.note)}</p>` : ''}${conflict ? '<p role="alert">Hay una versión nueva. Su borrador se conserva; pulse «Actualizar» para cargarla y descartar sus cambios.</p>' : ''}${table(s.items, editable, s.customer)}<strong class="chat-order-total">${total(s.items)}</strong>${editable ? `<label class="chat-order-note-label">${s.customer ? 'Cambios que solicita' : 'Observaciones para el cliente'}<textarea data-field="note" maxlength="2000" rows="2" placeholder="Opcional">${esc(s.note)}</textarea></label>` : ''}<div class="chat-order-actions">${editable ? s.customer ? `<button type="button" data-action="approve" ${s.dirty ? 'disabled' : ''}>Aprobar y enviar</button><button type="button" data-action="requestChanges">Solicitar cambios</button>` : '<button type="button" data-action="saveQuote">Guardar borrador</button><button type="button" data-action="sendQuote">Enviar al cliente</button>' : ''}${s.dirty || conflict ? '<button type="button" data-action="refresh">Actualizar / descartar</button>' : ''}<button type="button" data-action="history">Historial</button></div>${s.busy ? '<p role="status">Guardando…</p>' : ''}<p class="chat-order-error" role="alert">${esc(s.error)}</p>${o.status === 'approved' ? '<small>Confirmado por el cliente. Precios y cantidades quedan cerrados.</small>' : ''}<div class="chat-order-history">${s.historyHtml || ''}</div>`;
  }
  function redraw(s) {
    const node = document.querySelector(`[data-chat-order="${CSS.escape(s.order.id)}"]`);
    if (node) node.innerHTML = content(s);
  }
  window.chatOrders = {
    beforeRender() {
      const el = document.activeElement, card = el?.closest('[data-chat-order]');
      focus = card ? { id: card.dataset.chatOrder, field: el.dataset.field, line: el.dataset.line, scroll: document.querySelector('#messageList').scrollTop } : null;
    },
    render(order, user, observer) {
      let s = states.get(order.id);
      if (s?.userId === user.id && s.order.revision > order.revision) order = s.order;
      if (!s || s.userId !== user.id) {
        s = { userId: user.id, customer: user.id === order.clientId && user.role === 'client', internal: ['admin', 'employee', 'seller'].includes(user.role) };
        reset(s, order); states.set(order.id, s);
      } else if (!s.dirty && !s.busy && s.base !== order.revision) reset(s, order);
      s.order = order; s.observer = observer;
      return `<section class="chat-order" data-chat-order="${esc(order.id)}">${content(s)}</section>`;
    },
    afterRender() {
      if (!focus) return false;
      const card = document.querySelector(`[data-chat-order="${CSS.escape(focus.id)}"]`);
      const el = [...(card?.querySelectorAll('[data-field]') || [])].find(i => i.dataset.field === focus.field && i.dataset.line === focus.line);
      el?.focus({ preventScroll: true }); document.querySelector('#messageList').scrollTop = focus.scroll;
      return true;
    }
  };
  const list = document.querySelector('#messageList');
  list.addEventListener('input', event => {
    const el = event.target, card = el.closest('[data-chat-order]'); if (!card || !el.dataset.field) return;
    const s = states.get(card.dataset.chatOrder); s.dirty = true; s.actionId = null;
    if (el.dataset.field === 'note') s.note = el.value;
    else {
      const i = s.items[Number(el.dataset.line)]; i[el.dataset.field] = el.value === '' ? null : Number(el.value);
      i.amount = i.price3 == null || i.quantity == null ? null : Math.round(i.quantity * i.price3 * 100) / 100;
      card.querySelector(`[data-amount="${el.dataset.line}"]`).textContent = money(i.amount);
      card.querySelector('.chat-order-total').textContent = total(s.items);
    }
    const approve = card.querySelector('[data-action="approve"]'); if (approve) approve.disabled = true;
  });
  list.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || !event.target.closest('.chat-order')) return;
    event.preventDefault(); const inputs = [...event.target.closest('.chat-order').querySelectorAll('input')]; inputs[inputs.indexOf(event.target) + 1]?.focus();
  });
  list.addEventListener('click', async event => {
    const reference = event.target.closest('[data-open-order]');
    if (reference) {
      document.querySelector(`[data-chat-order="${CSS.escape(reference.dataset.openOrder)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const button = event.target.closest('[data-action]'), card = button?.closest('[data-chat-order]'); if (!card) return;
    const s = states.get(card.dataset.chatOrder), action = button.dataset.action; if (s.busy) return;
    s.error = '';
    try {
      if (action === 'history') {
        const order = await api(s.order.id);
        s.historyHtml = `<details open><summary>Versiones del pedido</summary>${(order.history || []).slice().reverse().map(h => `<details><summary>V${h.revision} · ${labels[h.status]} · ${esc(h.userName)} · ${esc(new Date(h.at).toLocaleString('es-DO'))}</summary>${table(h.items, false, false)}<strong>${total(h.items)}</strong><p>${esc(h.note)}</p></details>`).join('')}</details>`;
        redraw(s); return;
      }
      if (action === 'refresh') { reset(s, await api(s.order.id)); s.historyHtml = ''; redraw(s); return; }
      if ([...card.querySelectorAll('input,textarea')].some(el => !el.reportValidity())) return;
      if (action === 'approve' && s.dirty) throw new Error('Envíe sus cambios para recibir una nueva cotización antes de aprobar.');
      if (s.pendingAction !== action) s.actionId = null;
      s.pendingAction = action; s.actionId ||= crypto.randomUUID(); s.busy = true; redraw(s);
      const order = await api(s.order.id, { method: 'PATCH', body: JSON.stringify({ action, actionId: s.actionId, revision: s.base, items: s.items.map(i => ({ productId: i.productId, quantity: i.quantity, price3: i.price3 })), note: s.note }) });
      reset(s, order); s.historyHtml = '';
    } catch (error) { s.error = error.message; }
    finally { s.busy = false; redraw(s); }
  });
})();
