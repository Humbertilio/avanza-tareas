(() => {
  const fields = ['material','calibre','ancho','peso','gramaje','ubicacion','externalId','observacion','destino'];
  const labels = {material:'MAT',calibre:'CAL',ancho:'ANC',peso:'PESO',gramaje:'GSM',ubicacion:'UBI',externalId:'ID',observacion:'Observación',destino:'Destino'};
  const widths = {material:4,calibre:4,ancho:4,peso:6,gramaje:3,ubicacion:3,externalId:7,observacion:15,destino:15};
  const clientFields = ['material','calibre','ancho','peso','gramaje','observacion','externalId'];
  const state = {items:[],materials:[],movements:[],imports:[],orders:[],tab:'items',filters:{},sort:{key:'material',dir:1},selected:new Set(),clickTimer:null,longPressTimer:null,longPressTriggered:false};
  const root = () => document.querySelector('#inventoryRoot');
  const safe = value => escapeHtml(String(value ?? ''));
  const display = value => value === null || value === undefined || value === '' ? '—' : safe(value);
  const displayField = (key,value) => key === 'peso' && value !== null && value !== undefined && value !== '' ? safe(Number(value).toLocaleString('en-US',{maximumFractionDigits:0})) : display(value);
  const statusText = value => ({pending:'Pendiente',review:'Revisión',approved:'Aprobada',rejected:'Rechazada',completed:'Completada'})[value] || value;
  let draft = {}, modalReturn = null;
  const inventoryActive = () => !document.querySelector('#inventoryView').classList.contains('hidden');
  function rememberDraft() {
    root().querySelectorAll('[data-new-field]').forEach(input => { draft[input.dataset.newField] = input.value; });
  }
  function updateLayout() {
    if (!inventoryActive()) return;
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--inventory-height', `${viewport?.height || window.innerHeight}px`);
    document.documentElement.style.setProperty('--inventory-top', `${viewport?.offsetTop || 0}px`);
    const heading = root().querySelector('.inventory-sheet thead');
    document.documentElement.style.setProperty('--inventory-dialog-top', `${Math.max(0, heading?.getBoundingClientRect().bottom || 40) + 4}px`);
  }
  window.visualViewport?.addEventListener('resize', updateLayout);
  window.visualViewport?.addEventListener('scroll', updateLayout);
  window.addEventListener('resize', updateLayout);
  window.setInventoryActive = active => {
    if (active) requestAnimationFrame(updateLayout);
    else { rememberDraft(); closeModal(false); }
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && inventoryActive() && document.querySelector('#inventoryModal:not(.hidden)')) {
      event.preventDefault(); event.stopImmediatePropagation(); closeModal();
    }
  }, true);

  async function load() {
    const data = await request('/api/inventory');
    Object.assign(state, data);
    render();
  }

  function visibleItems() {
    const visibleFields = me.role === 'client' ? clientFields : fields;
    return state.items.filter(item => visibleFields.every(key => !state.filters[key] || String(item[key] ?? '').toLowerCase().includes(state.filters[key].toLowerCase()))).sort((a,b) => {
      const av=a[state.sort.key], bv=b[state.sort.key];
      return (typeof av==='number'&&typeof bv==='number' ? av-bv : String(av??'').localeCompare(String(bv??''),'es',{numeric:true,sensitivity:'base'}))*state.sort.dir;
    });
  }

  function render() {
    rememberDraft();
    const tabs = me.role === 'client' ? [['items','Inventario'],['orders','Solicitudes']] : me.role === 'admin' ? [['items','Inventario'],['movements','Movimientos'],['orders','Solicitudes'],['imports','Importaciones']] : [['items','Inventario'],['movements','Movimientos'],['imports','Importaciones']];
    if (!tabs.some(([key]) => key === state.tab)) state.tab = 'items';
    root().innerHTML = `<div class="inventory-heading"><button type="button" id="inventoryBack" aria-label="Volver">&lt;</button><strong>Inventario</strong></div><div id="inventoryContent"></div><div class="inventory-bottom"><div class="inventory-tabs">${tabs.map(([key,label])=>`<button data-inv-tab="${key}" class="${state.tab===key?'active':''}">${label}</button>`).join('')}</div>${state.tab==='items'&&me.role!=='client'?'<button id="inventorySave">Guardar</button><button id="inventoryImport">Importar</button><button id="inventoryAddMaterial">Agregar material</button><input id="inventoryFile" type="file" accept=".xlsx,.xls" hidden>':''}${state.tab==='items'&&me.role==='client'&&state.selected.size?`<button id="inventoryCart">Comprar (${state.selected.size})</button>`:''}</div>`;
    if(state.tab==='items') renderItems();
    if(state.tab==='movements') renderMovements();
    if(state.tab==='orders') renderOrders();
    if(state.tab==='imports') renderImports();
    root().querySelectorAll('[data-inv-tab]').forEach(button => button.addEventListener('click',()=>{state.tab=button.dataset.invTab;render();}));
    root().querySelector('#inventoryBack').addEventListener('click',()=>{ if(history.state?.view==='inventory' && history.length>1)history.back();else window.showAvanzaView(me.role==='client'?'chat':'tasks'); });
    root().querySelector('#inventoryAddMaterial')?.addEventListener('click',()=>addMaterial());
    root().querySelector('#inventorySave')?.addEventListener('click',addInlineItem);
    root().querySelector('#inventoryImport')?.addEventListener('click',()=>root().querySelector('#inventoryFile').click());
    root().querySelector('#inventoryFile')?.addEventListener('change',event=>importExcel(event.target.files[0]));
    root().querySelector('#inventoryCart')?.addEventListener('click',openCart);
  }

  function renderItems() {
    rememberDraft();
    const keys = me.role === 'client' ? clientFields : fields, items = visibleItems(), content = root().querySelector('#inventoryContent');
    content.innerHTML = `<div class="inventory-count">${items.length}</div><div class="inventory-sheet"><table><thead><tr>${keys.map(key=>`<th data-sort="${key}" style="width:${widths[key]}ch;min-width:${widths[key]}ch" title="Ordenar">${labels[key]} ${state.sort.key===key?(state.sort.dir===1?'▲':'▼'):''}</th>`).join('')}</tr><tr class="inventory-filters">${keys.map(key=>`<th><input data-filter="${key}" value="${safe(state.filters[key]||'')}" aria-label="Filtrar ${labels[key]}"></th>`).join('')}</tr></thead><tbody>${items.map(item=>`<tr data-item="${item.id}" class="${item.active?'':'inactive'} ${state.selected.has(item.id)?'selected':''}">${keys.map(key=>`<td title="${safe(item[key]??'')}">${displayField(key,item[key])}</td>`).join('')}</tr>`).join('')}${me.role!=='client'?`<tr id="inventoryNewRow" class="inventory-new-row">${keys.map(key=>`<td><input data-new-field="${key}" maxlength="${{material:4,ubicacion:6,externalId:7,observacion:40,destino:40}[key]||20}" inputmode="${['calibre','peso','gramaje'].includes(key)?'numeric':key==='ancho'?'decimal':'text'}" aria-label="Nuevo ${labels[key]}" placeholder="${key==='material'?'＋':''}"></td>`).join('')}</tr>`:''}</tbody></table></div>`;
    content.querySelectorAll('[data-sort]').forEach(th=>th.addEventListener('click',()=>{const key=th.dataset.sort;if(state.sort.key===key)state.sort.dir*=-1;else state.sort={key,dir:1};renderItems();}));
    content.querySelectorAll('[data-filter]').forEach(input=>input.addEventListener('input',()=>{state.filters[input.dataset.filter]=input.value;renderItems();const next=root().querySelector(`[data-filter="${input.dataset.filter}"]`);next?.focus();next?.setSelectionRange(input.value.length,input.value.length);}));
    content.querySelectorAll('[data-item]').forEach(row=>{
      const item=state.items.find(x=>x.id===row.dataset.item);if(!item)return;
      row.addEventListener('click',()=>{
        if(state.longPressTriggered){state.longPressTriggered=false;return;}
        if(me.role==='client'){state.selected.has(item.id)?state.selected.delete(item.id):state.selected.add(item.id);render();return;}
        clearTimeout(state.clickTimer);state.clickTimer=setTimeout(()=>openMovement(item),240);
      });
      if(me.role!=='client')row.addEventListener('dblclick',()=>{clearTimeout(state.clickTimer);openItem(item);});
      if(me.role==='admin'){
        let startX=0,startY=0;
        const stopHold=()=>{clearTimeout(state.longPressTimer);row.classList.remove('holding');};
        row.addEventListener('pointerdown',event=>{if(event.pointerType==='mouse')return;startX=event.clientX;startY=event.clientY;state.longPressTriggered=false;stopHold();row.classList.add('holding');try{row.setPointerCapture(event.pointerId);}catch{}state.longPressTimer=setTimeout(()=>{state.longPressTriggered=true;clearTimeout(state.clickTimer);row.classList.remove('holding');deleteItem(item);},2000);});
        row.addEventListener('pointermove',event=>{if(Math.abs(event.clientX-startX)>14||Math.abs(event.clientY-startY)>14)stopHold();});
        ['pointerup','pointercancel'].forEach(type=>row.addEventListener(type,stopHold));
        row.addEventListener('contextmenu',event=>event.preventDefault());
      }
    });
    content.querySelectorAll('[data-new-field]').forEach(input=>input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addInlineItem();}}));
    const materialInput=content.querySelector('[data-new-field="material"]');
    if (materialInput) {
      const button=document.createElement('button');
      button.type='button';button.className='inventory-material-select';button.dataset.newField='material';
      button.setAttribute('aria-label','Seleccionar material');button.setAttribute('aria-haspopup','dialog');
      button.value=draft.material||'';button.textContent=button.value||'＋';
      materialInput.replaceWith(button);button.addEventListener('click',openMaterialPicker);
    }
    content.querySelectorAll('input[data-new-field]').forEach(input=>{
      input.value=draft[input.dataset.newField]||'';
      input.addEventListener('input',()=>{draft[input.dataset.newField]=input.value;});
    });
    requestAnimationFrame(updateLayout);
  }

  function modal(html, onReturn = null) {
    let node=document.querySelector('#inventoryModal');
    if(!node){node=document.createElement('div');node.id='inventoryModal';node.className='modal';document.body.appendChild(node);}
    modalReturn=onReturn;node.innerHTML=html;node.classList.remove('hidden');
    node.setAttribute('role','dialog');node.setAttribute('aria-modal','true');
    const heading=node.querySelector('h2');if(heading){heading.id='inventoryDialogTitle';node.setAttribute('aria-labelledby',heading.id);}
    node.onclick=event=>{if(event.target===node)closeModal();};
    node.onkeydown=event=>{
      if(event.key!=='Tab')return;
      const controls=[...node.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    updateLayout();return node;
  }
  function closeModal(returnToPrevious = true){
    document.querySelector('#inventoryModal')?.classList.add('hidden');
    const callback=modalReturn;modalReturn=null;
    if(returnToPrevious && callback)callback();
  }
  async function addInlineItem(){
    const row=root().querySelector('#inventoryNewRow');if(!row||row.dataset.saving)return;
    rememberDraft();const payload={...draft};if(!Object.values(payload).some(value=>value.trim()))return;
    if(!payload.material){openMaterialPicker();return;}
    row.dataset.saving='1';
    try{
      await request('/api/inventory/items',{method:'POST',body:JSON.stringify(payload)});
      draft={};row.querySelectorAll('[data-new-field]').forEach(input=>{input.value='';});
      await load();toast('Artículo agregado');
    }catch(error){delete row.dataset.saving;toast(error.message);}
  }
  function selectMaterial(material){
    draft.material=material;
    const input=root().querySelector('[data-new-field="material"]');
    if(input){input.value=material;input.textContent=material;}
    closeModal(false);root().querySelector('[data-new-field="calibre"]')?.focus();
  }
  function addMaterial(fromPicker = false){
    rememberDraft();
    const node=modal('<form class="modal-card"><div class="modal-heading"><h2>Agregar material</h2><button type="button" data-close aria-label="Volver">&lt;</button></div><label>Código<input name="material" maxlength="4" pattern="[A-Za-z0-9]{1,4}" required></label><label>Descripción<input name="descripcion" maxlength="100" required></label><button type="submit" class="primary">Guardar material</button><p class="formMessage" role="alert"></p></form>',fromPicker?openMaterialPicker:null);
    node.querySelector('[data-close]').addEventListener('click',()=>closeModal());
    node.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;
      try{
        const result=await request('/api/inventory/materials',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
        state.materials.push(result.material);selectMaterial(result.material.material);toast('Material agregado');
      }catch(error){form.querySelector('.formMessage').textContent=error.message;}
      finally{button.disabled=false;}
    });
    node.querySelector('[name="material"]').focus();
  }
  function openMaterialPicker(){
    rememberDraft();
    const materials=[...state.materials].sort((a,b)=>a.material.localeCompare(b.material,'es',{numeric:true,sensitivity:'base'}));
    const node=modal('<div class="modal-card material-picker"><div class="modal-heading"><h2>Material</h2><button type="button" data-close aria-label="Cerrar">×</button></div><input data-material-search placeholder="Buscar" aria-label="Buscar material"><div class="material-list">'+materials.map(item=>'<button type="button" data-material="'+safe(item.material)+'"><b>'+safe(item.material)+'</b><span>'+safe(item.descripcion)+'</span></button>').join('')+'<button type="button" class="material-add" aria-label="Agregar otro material" title="Agregar otro material"><span aria-hidden="true">＋</span></button></div></div>');
    node.querySelector('[data-close]').addEventListener('click',()=>closeModal());
    node.querySelectorAll('[data-material]').forEach(button=>button.addEventListener('click',()=>selectMaterial(button.dataset.material)));
    node.querySelector('.material-add').addEventListener('click',()=>addMaterial(true));
    node.querySelector('[data-material-search]').addEventListener('input',event=>{
      const text=event.target.value.toLocaleLowerCase('es');
      node.querySelectorAll('[data-material]').forEach(button=>button.classList.toggle('hidden',!button.textContent.toLocaleLowerCase('es').includes(text)));
    });
    // Keep the keyboard closed until the user chooses to search.
    node.querySelector('[data-close]').focus({preventScroll:true});
  }
  async function deleteItem(item){if(!confirm('¿Borrar este artículo?'))return;try{await request(`/api/inventory/items/${item.id}`,{method:'DELETE'});closeModal();await load();toast('Artículo borrado');}catch(error){toast(error.message);}}
  function itemInputs(item={}) { return fields.map(key=>`<label>${labels[key]}<input name="${key}" value="${safe(item[key]??'')}" ${key==='material'?'required':''} maxlength="${{material:4,ubicacion:6,externalId:7,observacion:40,destino:40}[key]||20}" inputmode="${['calibre','peso','gramaje'].includes(key)?'numeric':key==='ancho'?'decimal':'text'}"></label>`).join(''); }

  function openItem(item=null) {
    const node=modal(`<form class="modal-card inventory-form"><div class="modal-heading"><h2>${item?'Editar':'Nuevo'}</h2><button type="button" data-close>×</button></div><div class="inventory-fields">${itemInputs(item||{})}</div><div class="modal-actions">${item&&me.role==='admin'?'<button type="button" class="inventory-delete">Borrar</button>':'<button type="button" data-close>Cancelar</button>'}<button class="primary">Guardar</button></div><p class="formMessage"></p></form>`);
    node.querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click',closeModal));
    node.querySelector('.inventory-delete')?.addEventListener('click',()=>deleteItem(item));
    node.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target,msg=form.querySelector('.formMessage');try{await request(item?`/api/inventory/items/${item.id}`:'/api/inventory/items',{method:item?'PATCH':'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});closeModal();await load();toast(item?'Artículo actualizado':'Artículo agregado');}catch(error){msg.textContent=error.message;}});
    node.querySelector('[name="material"]').focus();
  }

  function openMovement(item) {
    const type=item.active?'exit':'entry', node=modal(`<form class="modal-card"><div class="modal-heading"><h2>${type==='exit'?'Salida':'Entrada'}</h2><button type="button" data-close>×</button></div><p><strong>${safe(item.material)}</strong> · ${safe(item.externalId||'Sin ID')}</p>${type==='exit'?'<label>Destino<input name="destination" maxlength="40" required></label>':''}<label>Observación<textarea name="note" maxlength="40" rows="4"></textarea></label><button class="primary">Confirmar</button><p class="formMessage"></p><small class="inventory-edit-hint">Doble clic en la fila para editar.</small></form>`);
    node.querySelector('[data-close]').addEventListener('click',closeModal);
    node.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;try{await request('/api/inventory/movements',{method:'POST',body:JSON.stringify({...Object.fromEntries(new FormData(form)),itemId:item.id,type})});closeModal();await load();toast(type==='exit'?'Salida registrada':'Entrada registrada');}catch(error){form.querySelector('.formMessage').textContent=error.message;}});
  }

  async function importExcel(file) {
    if(!file)return;
    root().querySelector('#inventoryImportErrors')?.remove();
    const button=root().querySelector('#inventoryImport');button.disabled=true;button.textContent='Revisando archivo…';
    try{
      const buffer=await file.arrayBuffer(),bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const response=await fetch('/api/inventory/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName:file.name,content:btoa(binary)})}),result=await response.json();
      if(!response.ok){
        if(result.errors?.length){
          const panel=document.createElement('section');panel.id='inventoryImportErrors';panel.setAttribute('role','alert');
          panel.innerHTML=`<h3>No se importó ningún registro</h3><p>${safe(file.name)}: ${result.errors.length} errores. Descargue la copia y revise las celdas rojas; cada celda incluye una nota con la causa.</p><button type="button" data-download-errors>Descargar Excel con errores</button>`;
          panel.querySelector('[data-download-errors]').addEventListener('click',()=>{const bytes=Uint8Array.from(atob(result.report.content),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),link=document.createElement('a');link.href=url;link.download=result.report.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
          root().querySelector('#inventoryContent').prepend(panel);panel.scrollIntoView({block:'start'});
        }
        throw new Error(result.error||'No se pudo importar');
      }
      await load();toast(`${result.imported} registros importados. Archivo completo validado.`);
    }catch(error){toast(error.message);}
    finally{button.disabled=false;button.textContent='Importar';const input=root().querySelector('#inventoryFile');if(input)input.value='';}
  }

  function renderMovements() {
    root().querySelector('#inventoryContent').innerHTML=`<div class="inventory-sheet inventory-history"><table><thead><tr><th>Material</th><th>Calibre</th><th>Ancho</th><th>Fecha</th><th>Destino</th><th>Observación</th></tr></thead><tbody>${state.movements.map(row=>`<tr><td>${display(row.material)}</td><td>${display(row.calibre)}</td><td>${display(row.ancho)}</td><td>${safe(dateTimeText(row.createdAt))}</td><td>${display(row.destination||'Entrada')}</td><td>${display(row.note)}</td></tr>`).join('')}</tbody></table>${state.movements.length?'':'<p class="inventory-empty">Sin movimientos</p>'}</div>`;
  }

  function renderOrders() {
    const itemName=id=>{const item=state.items.find(row=>row.id===id);return item?`${item.material} ${item.externalId||''}`:`#${id}`};
    root().querySelector('#inventoryContent').innerHTML=`<div class="inventory-sheet inventory-orders"><table><thead><tr>${me.role==='admin'?'<th>Cliente</th>':''}<th>Artículos</th><th>Comentarios</th><th>Fecha</th><th>Estado</th></tr></thead><tbody>${state.orders.map(order=>`<tr>${me.role==='admin'?`<td>${safe(order.customer)}</td>`:''}<td>${order.itemIds.map(itemName).map(safe).join(', ')}</td><td>${display(order.comments)}</td><td>${safe(dateTimeText(order.createdAt))}</td><td>${me.role==='admin'?`<select data-order="${order.id}">${['pending','review','approved','rejected','completed'].map(value=>`<option value="${value}" ${order.status===value?'selected':''}>${statusText(value)}</option>`).join('')}</select>`:safe(statusText(order.status))}</td></tr>`).join('')}</tbody></table>${state.orders.length?'':'<p class="inventory-empty">Sin solicitudes</p>'}</div>`;
    root().querySelectorAll('[data-order]').forEach(select=>select.addEventListener('change',async()=>{try{await request(`/api/inventory/orders/${select.dataset.order}`,{method:'PATCH',body:JSON.stringify({status:select.value})});await load();toast('Solicitud actualizada');}catch(error){toast(error.message);}}));
  }

  function renderImports() {
    root().querySelector('#inventoryContent').innerHTML=`<div class="inventory-sheet"><table><thead><tr><th>Archivo</th><th>Hoja</th><th>Importados</th><th>Omitidos</th><th>Usuario</th><th>Fecha</th></tr></thead><tbody>${state.imports.map(row=>`<tr><td>${safe(row.fileName)}</td><td>${safe(row.sheetName)}</td><td>${row.importedRows}</td><td>${row.skippedRows}</td><td>${safe(row.importedBy)}</td><td>${safe(dateTimeText(row.importedAt))}</td></tr>`).join('')}</tbody></table>${state.imports.length?'':'<p class="inventory-empty">Sin importaciones</p>'}</div>`;
  }

  function openCart() {
    const chosen=[...state.selected].map(id=>state.items.find(item=>item.id===id)).filter(Boolean), node=modal(`<form class="modal-card inventory-cart"><div class="modal-heading"><h2>Solicitud</h2><button type="button" data-close>×</button></div><div class="inventory-cart-items">${chosen.map(item=>`<p><b>${safe(item.material)}</b> · ${safe(item.externalId||'Sin ID')} · ${display(item.ancho)}</p>`).join('')}</div><label>Comentarios<textarea name="comments" maxlength="500" rows="5"></textarea></label><button class="primary">Enviar</button><p class="formMessage"></p></form>`);
    node.querySelector('[data-close]').addEventListener('click',closeModal);
    node.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;try{await request('/api/inventory/orders',{method:'POST',body:JSON.stringify({itemIds:[...state.selected],comments:new FormData(form).get('comments')})});state.selected.clear();state.tab='orders';closeModal();await load();toast('Solicitud enviada');}catch(error){form.querySelector('.formMessage').textContent=error.message;}});
  }

  window.loadInventory = () => load().catch(error=>{root().innerHTML=`<p class="inventory-empty">${safe(error.message)}</p>`;});
})();
