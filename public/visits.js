/* Device-local outbox. The server authenticates and deduplicates every operation. */
(() => {
  'use strict';
  const q = s => document.querySelector(s), esc = escapeHtml;
  let map, layers, selected = '', mode = 'clients', search = '', seller = '', day = today(), syncing = false, busy = false, mapPicking = false, lastError = '';
  const empty = () => ({ clients: [], visits: [], sellers: [], lastVisits: {}, pending: [] });
  const key = () => `avanza-visits-v1:${me.id}`;
  function read() { const raw = localStorage.getItem(key()); return raw ? { ...empty(), ...JSON.parse(raw) } : empty(); }
  function write(s) { localStorage.setItem(key(), JSON.stringify(s)); }
  function today(value = new Date()) { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  const time = value => new Date(value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const date = value => new Date(value).toLocaleString('es', { day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit' });
  const located = c => c?.point && Number.isFinite(c.point.latitude) && Number.isFinite(c.point.longitude);
  const latlng = p => [p.latitude, p.longitude];
  const lock = fn => navigator.locks ? navigator.locks.request(key(), fn) : fn();
  async function api(url, data) {
    const response = await fetch(url, { ...(data ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) } : {}), signal:AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'No se pudo sincronizar'), { status: response.status });
    return result;
  }
  function projected(s) {
    const result = structuredClone(s);
    for (const op of s.pending) {
      const d = op.data;
      if (op.type === 'client' && !result.clients.some(c => c.id === d.id)) result.clients.push({ ...d, pending:true });
      if (op.type === 'location') { const c = result.clients.find(c => c.id === d.clientId); if (c) c.point = d.point; }
      if (op.type === 'arrival' && !result.visits.some(v => v.id === d.id)) result.visits.push({ ...d, userId:me.id, pending:true });
      if (op.type === 'finish') { const v = result.visits.find(v => v.id === d.id); if (v) Object.assign(v, d, {pending:true}); }
    }
    return result;
  }
  async function enqueue(type, data) {
    await lock(() => {
      const s = read();
      if (type === 'arrival' && projected(s).visits.some(v => v.userId === me.id && !v.endedAt)) throw new Error('Finaliza tu visita anterior primero');
      s.pending.push({ id:crypto.randomUUID(), type, data }); write(s);
    });
    render(); void sync();
  }
  async function sync() {
    if (syncing || !me || !['seller','admin'].includes(me.role)) return;
    syncing = true; lastError = ''; status();
    try {
      await lock(async () => {
        let s = read();
        while (s.pending.length) {
          await api('/api/field/sync', s.pending[0]);
          // Preserve optimistic records until the following server snapshot succeeds.
          const optimistic = projected({ ...s, pending:[s.pending[0]] });
          optimistic.pending = s.pending.slice(1); write(optimistic); s = read();
        }
        const data = await api('/api/field/data'); write({ ...data, pending:read().pending });
      });
    } catch (error) { lastError = error.status === 401 ? 'Inicia sesión para sincronizar. Tus registros siguen guardados.' : error.status ? error.message : 'Sin conexión al servidor. Los registros se guardan en este celular.'; }
    finally { syncing = false; if (q('#visitsView') && !q('#visitsView').classList.contains('hidden')) render(); }
  }
  function status() {
    const node = q('#visitStatus'); if (!node) return;
    const s = read(); node.textContent = syncing ? 'Sincronizando…' : `${s.pending.length ? `${s.pending.length} pendientes de sincronizar` : 'Todo sincronizado'}${s.downloadedAt ? ' · '+date(s.downloadedAt) : ''}`;
    if (lastError) node.textContent += ' · '+lastError;
    node.classList.toggle('warning', Boolean(s.pending.length || lastError));
  }
  function mount() {
    q('#visitsView').innerHTML = `<div class="visit-toolbar"><h2>Clientes y visitas</h2><div class="visit-actions"><button id="visitNew" class="primary">＋ Cliente</button><button id="visitSync">Sincronizar</button></div></div><p id="visitStatus" class="visit-status" role="status"></p><div class="visit-filters"><button class="visit-mode" data-mode="clients">Clientes</button><button class="visit-mode" data-mode="day">Jornada</button><input id="visitSearch" type="search" aria-label="Buscar cliente o zona" placeholder="Cliente o zona"><input id="visitDay" type="date" aria-label="Fecha de jornada"><select id="visitSeller" aria-label="Vendedor"></select></div><div class="visit-workspace"><div id="visitList" class="visit-list"></div><div class="visit-map-panel"><div id="visitMap" class="visit-map" aria-label="Mapa de clientes"></div><p id="visitCaption" class="visit-caption"></p><div id="visitDetail" class="visit-detail"></div></div></div><dialog id="visitDialog" class="visit-dialog"></dialog>`;
    map = L.map('visitMap').setView([-16.5,-68.15], 12); layers = L.featureGroup().addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map).on('tileerror', () => { q('#visitCaption').textContent = 'Mapa base no disponible. Puedes registrar visitas desde la lista.'; });
    map.on('click', e => {
      if (!mapPicking) return; mapPicking = false;
      const dialog = q('#visitDialog'); dialog.showModal();
      dialog.querySelector('[name=latitude]').value = e.latlng.lat.toFixed(6);
      dialog.querySelector('[name=longitude]').value = e.latlng.lng.toFixed(6);
      q('#visitCaption').textContent = 'Ubicación seleccionada';
    });
    q('#visitNew').onclick = () => clientDialog(); q('#visitSync').onclick = sync;
    q('#visitSearch').oninput = e => { search=e.target.value; renderRows(); };
    q('#visitDay').onchange = e => { day=e.target.value; renderRows(); };
    q('#visitSeller').onchange = e => { seller=e.target.value; renderRows(); };
    document.querySelectorAll('[data-mode]').forEach(b => b.onclick=() => { mode=b.dataset.mode; render(); });
  }
  function render() {
    if (!me || !['seller','admin'].includes(me.role)) return;
    if (!q('#visitMap')) mount();
    const s = projected(read());
    if (!seller) seller=me.id;
    q('#visitSeller').innerHTML = s.sellers.map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
    q('#visitSeller').value=seller; q('#visitSeller').hidden=mode!=='day'||me.role!=='admin';
    q('#visitDay').value=day; q('#visitDay').hidden=mode!=='day';
    document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
    status(); renderRows(); setTimeout(() => map.invalidateSize(),0);
  }
  function renderRows() {
    const s = projected(read()), normalized = search.trim().toLocaleLowerCase('es');
    const matching = s.clients.filter(c => `${c.name} ${c.address} ${c.city}`.toLocaleLowerCase('es').includes(normalized));
    const visits = s.visits.filter(v => v.userId===seller && today(v.arrivedAt)===day).sort((a,b) => a.arrivedAt.localeCompare(b.arrivedAt));
    const rows = mode==='clients' ? matching.map(c => ({c})) : visits.map((v,i) => ({v,i,c:s.clients.find(c => c.id===v.clientId)})).filter(r => r.c && matching.some(c => c.id===r.c.id));
    q('#visitList').innerHTML = rows.map(({c,v,i}) => {
      const last = s.lastVisits[c.id], ongoing=s.visits.find(v => v.clientId===c.id && v.userId===me.id && !v.endedAt);
      return `<article class="visit-row ${selected===c.id?'selected':''}"><button class="visit-selected-title" data-client="${esc(c.id)}"><strong>${v?`${i+1}. `:''}${esc(c.name)}</strong></button><small>${esc([c.address,c.city].filter(Boolean).join(' · ')||'Sin dirección')}</small><small>${v ? `${time(v.arrivedAt)} → ${v.endedAt?time(v.endedAt):'En visita'} · ${v.endedAt?Math.round((Date.parse(v.endedAt)-Date.parse(v.arrivedAt))/60000)+' min · ':''}${esc(v.result)}` : last ? `Última: ${date(last.arrivedAt)} · ${esc(last.seller)}` : 'Sin visitas anteriores'}</small>${v?.note?`<small>${esc(v.note)}</small>`:''}<small>${!located(c)?'Sin ubicación · ':''}${v?.pending||c.pending?'Pendiente de sincronizar':''}${v&&!v.point?' · Llegada sin GPS':''}</small>${ongoing?`<button data-finish="${esc(ongoing.id)}" class="primary">Finalizar visita</button>`:''}</article>`;
    }).join('') || `<p class="visit-empty">${mode==='day'?'No hay visitas para esta fecha.':'No hay clientes que mostrar. Agrega un cliente o sincroniza.'}</p>`;
    q('#visitList').querySelectorAll('[data-client]').forEach(b => b.onclick=() => {selected=b.dataset.client;renderRows();});
    q('#visitList').querySelectorAll('[data-finish]').forEach(b => b.onclick=() => finishDialog(b.dataset.finish));
    layers.clearLayers();
    const route=[];
    rows.forEach(({c,v,i}) => {
      const p=mode==='day'?v.point:c.point; if (!p) return;
      const marker=L.marker(latlng(p), {icon:L.divIcon({className:'visit-pin',html:mode==='day'?String(i+1):'•',iconSize:[30,30]})}).addTo(layers);
      marker.bindTooltip(esc(c.name)); marker.on('click',()=>{selected=c.id;detail(s);});
      if(mode==='day')route.push(latlng(p));
    });
    if(mode==='day' && route.length>1)L.polyline(route,{color:'#1761b1',weight:3,dashArray:'6 7'}).addTo(layers);
    if(layers.getLayers().length) map.fitBounds(layers.getBounds(),{padding:[24,24],maxZoom:16});
    q('#visitCaption').textContent=mapPicking?'Toca el mapa para elegir la ubicación.':mode==='day'?`${visits.length} visitas · Líneas entre llegadas registradas; no representan las calles recorridas.`:`${matching.length} clientes · ${matching.filter(c=>!located(c)).length} sin ubicación. El mapa base necesita internet.`;
    detail(s);
  }
  function detail(s) {
    const c=s.clients.find(c=>c.id===selected), node=q('#visitDetail');
    if(!c){node.innerHTML='<p>Selecciona un cliente para registrar una visita.</p>';return;}
    const active=s.visits.find(v=>v.userId===me.id&&!v.endedAt);
    node.innerHTML=`<h3>${esc(c.name)}</h3><p>${esc([c.contact,c.phone,c.address,c.city].filter(Boolean).join(' · '))}</p><div class="visit-actions">${active?.clientId===c.id?'<button id="visitFinish" class="primary">Finalizar visita</button>':`<button id="visitArrive" class="primary" ${active?'disabled':''}>Registrar llegada</button>`}${located(c)?`<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${c.point.latitude},${c.point.longitude}">Cómo llegar ↗</a>`:''}${!located(c)||me.role==='admin'?'<button id="visitLocate">'+(located(c)?'Corregir ubicación':'Ubicar cliente')+'</button>':''}</div>${active&&active.clientId!==c.id?'<p>Finaliza tu visita en curso antes de iniciar otra.</p>':''}`;
    if(q('#visitArrive'))q('#visitArrive').onclick=()=>arrive(c);
    if(q('#visitFinish'))q('#visitFinish').onclick=()=>finishDialog(active.id);
    if(q('#visitLocate'))q('#visitLocate').onclick=()=>clientDialog(c);
  }
  function gps() {
    return new Promise((resolve,reject)=>navigator.geolocation?navigator.geolocation.getCurrentPosition(p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy}),()=>reject(new Error('No se obtuvo el GPS. Revisa el permiso de ubicación o indica las coordenadas.')),{enableHighAccuracy:true,timeout:15000,maximumAge:0}):reject(new Error('Este celular no ofrece ubicación')));
  }
  function distance(a,b) { const r=Math.PI/180, x=(b.latitude-a.latitude)*r,y=(b.longitude-a.longitude)*r;return 6371000*2*Math.asin(Math.sqrt(Math.sin(x/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin(y/2)**2)); }
  function dialog(title,content,save) {
    const d=q('#visitDialog');d.innerHTML=`<div class="visit-toolbar"><h3>${esc(title)}</h3><button type="button" id="visitClose" aria-label="Cerrar">×</button></div><form>${content}<p role="status"></p><button class="primary" type="submit">Guardar</button></form>`;
    q('#visitClose').onclick=()=>d.close();d.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await save(e.target);d.close();}catch(error){d.querySelector('[role=status]').textContent=error.message;}finally{button.disabled=false;}};d.showModal();return d;
  }
  function clientDialog(existing) {
    const d=dialog(existing?'Ubicar '+existing.name:'Nuevo cliente',`${existing?'':`<label>Nombre<input name="name" required maxlength="200"></label><div class="visit-columns"><label>Ciudad / zona<input name="city" maxlength="200"></label><label>Teléfono<input name="phone" type="tel" maxlength="60"></label></div><label>Dirección y referencia<input name="address" maxlength="400"></label><label>Contacto<input name="contact" maxlength="200"></label>`}<div class="visit-actions"><button type="button" id="visitGPS">Usar mi ubicación</button><button type="button" id="visitPick">Marcar en mapa</button></div><div class="visit-columns"><label>Latitud<input name="latitude" type="number" step="any" min="-90" max="90" required value="${existing?.point?.latitude??''}"></label><label>Longitud<input name="longitude" type="number" step="any" min="-180" max="180" required value="${existing?.point?.longitude??''}"></label></div>`,async form=>{
      const data=Object.fromEntries(new FormData(form)),p={latitude:Number(data.latitude),longitude:Number(data.longitude)};
      if(existing)await enqueue('location',{clientId:existing.id,point:p});
      else {
        const duplicate=projected(read()).clients.find(c=>c.name.toLocaleLowerCase()===data.name.trim().toLocaleLowerCase()||(data.phone&&c.phone.replace(/\D/g,'')===data.phone.replace(/\D/g,''))||(located(c)&&distance(c.point,p)<30));
        if(duplicate&&!confirm(`Posible duplicado: ${duplicate.name}. ¿Guardar de todas formas?`))return Promise.reject(new Error('Revisa el cliente existente antes de guardar.'));
        const id=crypto.randomUUID();await enqueue('client',{id,name:data.name.trim(),city:data.city,address:data.address,contact:data.contact,phone:data.phone,point:p,createdAt:new Date().toISOString()});selected=id;render();
      }
      toast('Cliente guardado');
    });
    q('#visitGPS').onclick=async e=>{e.target.disabled=true;d.querySelector('[role=status]').textContent='Buscando ubicación…';try{const p=await gps();d.querySelector('[name=latitude]').value=p.latitude;d.querySelector('[name=longitude]').value=p.longitude;d.querySelector('[role=status]').textContent=`Precisión ±${Math.round(p.accuracy)} m`;}catch(error){d.querySelector('[role=status]').textContent=error.message;}finally{e.target.disabled=false;}};
    q('#visitPick').onclick=()=>{mapPicking=true;d.close();q('#visitCaption').textContent='Toca el mapa para elegir la ubicación.';q('#visitMap').scrollIntoView({block:'center'});};
  }
  async function arrive(c) {
    if(busy)return;busy=true;const button=q('#visitArrive');button.disabled=true;button.textContent='Obteniendo ubicación…';
    const arrivedAt=new Date().toISOString();
    try {
      let p=null,reason='';
      try{p=await gps();}catch{reason=prompt('No se obtuvo ubicación. Explica el motivo para guardar la llegada sin GPS:');if(!reason?.trim())return;}
      if(p&&located(c)&&distance(p,c.point)>200){reason=prompt(`Estás a unos ${Math.round(distance(p,c.point))} m del cliente (precisión ±${Math.round(p.accuracy)} m). Indica el motivo:`);if(!reason?.trim())return;}
      await enqueue('arrival',{id:crypto.randomUUID(),clientId:c.id,arrivedAt,point:p,reason});toast('Llegada registrada');
    }catch(error){toast(error.message);}finally{busy=false;render();}
  }
  function finishDialog(id) {
    dialog('Finalizar visita',`<label>Resultado<select name="result" required><option value="">Selecciona</option>${['Pedido realizado','Sin pedido','Cliente cerrado','Volver otro día'].map(v=>`<option>${v}</option>`).join('')}</select></label><label>Nota (opcional)<textarea name="note" rows="2" maxlength="1000"></textarea></label>`,async form=>{await enqueue('finish',{id,endedAt:new Date().toISOString(),...Object.fromEntries(new FormData(form))});toast('Visita finalizada');});
  }
  window.loadVisits=()=>{try{render();void sync();}catch(error){toast('No se pudo abrir el almacenamiento de visitas: '+error.message);}};
  window.addEventListener('online',()=>{if(me)void sync();});
  window.addEventListener('offline',()=>{lastError='Sin conexión. Puedes registrar visitas; el mapa base puede no estar disponible.';if(me&&q('#visitStatus'))status();});
  window.addEventListener('storage',e=>{if(me&&e.key===key()&&q('#visitMap'))render();});
  setInterval(()=>{if(me&&['seller','admin'].includes(me.role)&&navigator.onLine&&read().pending.length)void sync();},30000);
})();
