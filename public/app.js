const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let me = null, users = [], tasks = [], installPrompt = null;
let sortState = { key: 'createdAt', direction: 'desc' };
const taskFilters = { title: '', description: '', createdFrom: '', createdTo: '', creator: '', assignee: '', dueFrom: '', dueTo: '', status: '' };

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#installApp').innerHTML = '<span>✓</span> Avanza instalada'; toast('Avanza quedó instalada'); });

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación');
  return data;
}
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 2600); }
function initials(name) { return name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(); }
function dateText(value) { return new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)); }
function dateTimeText(value) { return new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function dueDateText(value) { if (!value) return 'Sin fecha'; const [year,month,day]=value.split('-'); return `${day}/${month}/${year}`; }

async function boot() {
  try { me = (await request('/api/me')).user; await enterApp(); }
  catch { $('#loginView').classList.remove('hidden'); }
}
async function enterApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#profileName').textContent = me.name; $('#profileRole').textContent = me.role === 'admin' ? 'Administrador' : 'Empleado'; $('#avatar').textContent = initials(me.name);
  if (me.role === 'admin') $('#usersNav').classList.remove('hidden');
  await refresh(); history.replaceState({ view: 'tasks' }, '', '#tasks'); showView('tasks', false);
}
async function refresh() {
  [users, tasks] = await Promise.all([request('/api/users').then(x => x.users), request('/api/tasks').then(x => x.tasks)]);
  users.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  const assigneeOptions = '<option value="">Selecciona un empleado</option>' + users.filter(x => x.active).map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  $('#assigneeSelect').innerHTML = assigneeOptions; $('#editAssigneeSelect').innerHTML = assigneeOptions;
  renderTasks(); renderUsers();
}
function escapeHtml(value) { const el = document.createElement('span'); el.textContent = value || ''; return el.innerHTML; }
function renderTasks() {
  const assigned = filteredAndSortedTasks(tasks.filter(task => task.assigneeId === me.id));
  const created = filteredAndSortedTasks(tasks.filter(task => task.creatorId === me.id && task.assigneeId !== me.id));
  $('#taskList').className = 'admin-table-wrap';
  $('#taskList').innerHTML = `${taskTable(assigned, 'No tienes tareas asignadas que coincidan con los filtros.')}<section class="created-tasks"><div class="section-title"><div><h2>Creadas por ti</h2><p>Tareas que asignaste a otros empleados</p></div></div>${taskTable(created, 'No tienes otras tareas creadas que coincidan con los filtros.')}</section>`;
  $('#allTaskList').className = 'admin-table-wrap';
  $('#allTaskList').innerHTML = taskTable(filteredAndSortedTasks(tasks), 'No hay tareas que coincidan con los filtros.');
  $$('#taskList select[data-id]').forEach(select => select.addEventListener('change', updateStatus));
  $$('.sort-btn').forEach(button => button.addEventListener('click',()=>{sortState={key:button.dataset.sort,direction:button.dataset.direction};renderTasks();}));
  $$('.task-filter').forEach(control => control.addEventListener('change',()=>{taskFilters[control.dataset.filter]=control.value;renderTasks();}));
  $$('.clear-filter').forEach(button => button.addEventListener('click',()=>{button.dataset.clear.split(',').forEach(key=>taskFilters[key]='');renderTasks();}));
  $$('.edit-task').forEach(button=>button.addEventListener('click',()=>openEditTask(button.dataset.id)));
  $$('.add-note').forEach(button=>button.addEventListener('click',()=>openNote(button.dataset.id)));
  $$('.description-cell').forEach(cell=>{let clickTimer;cell.addEventListener('click',()=>{if(!cell.classList.contains('can-comment'))return;clearTimeout(clickTimer);clickTimer=setTimeout(()=>openNote(cell.dataset.taskId),280);});cell.addEventListener('dblclick',event=>{event.preventDefault();clearTimeout(clickTimer);openDescription(cell.dataset.taskId);});cell.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&cell.classList.contains('can-comment')){event.preventDefault();openNote(cell.dataset.taskId);}});});
  $$('.acknowledge-task').forEach(button=>button.addEventListener('click',()=>acknowledgeTask(button.dataset.id)));
}
function taskTable(shown, emptyMessage) { return `<table class="admin-table excel-table"><thead><tr>${taskHeaders()}</tr></thead><tbody>${shown.length ? shown.map(taskRow).join('') : `<tr><td colspan="9"><div class="empty">${emptyMessage}</div></td></tr>`}</tbody></table>`; }
function statusOptions(task) { return `<option value="0" ${task.progress===0?'selected':''}>0%</option><option value="25" ${task.progress===25?'selected':''}>25%</option><option value="50" ${task.progress===50?'selected':''}>50%</option><option value="75" ${task.progress===75?'selected':''}>75%</option><option value="100" ${task.progress===100?'selected':''}>Finalizada</option>`; }
function sortButtons(key) { return `<span class="sort-controls"><button class="sort-btn ${sortState.key===key&&sortState.direction==='asc'?'active':''}" data-sort="${key}" data-direction="asc" title="Orden ascendente">↑</button><button class="sort-btn ${sortState.key===key&&sortState.direction==='desc'?'active':''}" data-sort="${key}" data-direction="desc" title="Orden descendente">↓</button></span>`; }
function filterMenu(keys, content) { const active=keys.some(key=>taskFilters[key]); return `<details class="excel-filter ${active?'active':''}"><summary title="Filtrar columna">⌄</summary><div class="filter-menu">${content}<button class="clear-filter" data-clear="${keys.join(',')}" type="button">Limpiar filtro</button></div></details>`; }
function taskHeaders() {
  const creators=[...new Set(tasks.map(x=>x.creatorName))].sort(), assignees=[...new Set(tasks.map(x=>x.assigneeName))].sort();
  const select=(key,values,label)=>`<label>${label}<select class="task-filter" data-filter="${key}"><option value="">Todos</option>${values.map(x=>`<option ${taskFilters[key]===x?'selected':''}>${escapeHtml(x)}</option>`).join('')}</select></label>`;
  const dates=(from,to)=>`<label>Desde<input class="task-filter" data-filter="${from}" type="date" value="${taskFilters[from]}"></label><label>Hasta<input class="task-filter" data-filter="${to}" type="date" value="${taskFilters[to]}"></label>`;
  return `<th>Tarea ${sortButtons('title')}${filterMenu(['title'],`<label>Contiene<input class="task-filter" data-filter="title" value="${escapeHtml(taskFilters.title)}"></label>`)}</th><th>Descripción ${filterMenu(['description'],`<label>Contiene<input class="task-filter" data-filter="description" value="${escapeHtml(taskFilters.description)}"></label>`)}</th><th>Fecha ${sortButtons('createdAt')}${filterMenu(['createdFrom','createdTo'],dates('createdFrom','createdTo'))}</th><th>Creada por ${sortButtons('creatorName')}${filterMenu(['creator'],select('creator',creators,'Persona'))}</th><th>Asignada a ${sortButtons('assigneeName')}${filterMenu(['assignee'],select('assignee',assignees,'Persona'))}</th><th>Terminación ${sortButtons('dueDate')}${filterMenu(['dueFrom','dueTo'],dates('dueFrom','dueTo'))}</th><th>Status ${sortButtons('progress')}${filterMenu(['status'],`<label>Estado<select class="task-filter" data-filter="status"><option value="">Todos</option>${[0,25,50,75,100].map(x=>`<option value="${x}" ${String(x)===taskFilters.status?'selected':''}>${x===100?'Finalizada':x+'%'}</option>`).join('')}</select></label>`)}</th><th>Lectura</th><th>Acciones</th>`;
}
function filteredAndSortedTasks(sourceTasks) {
  const filtered=sourceTasks.filter(task=>{const description=[task.description,...(task.notes||[]).map(note=>note.text)].join(' ').toLowerCase();return(!taskFilters.title||task.title.toLowerCase().includes(taskFilters.title.toLowerCase()))&&(!taskFilters.description||description.includes(taskFilters.description.toLowerCase()))&&(!taskFilters.createdFrom||task.createdAt.slice(0,10)>=taskFilters.createdFrom)&&(!taskFilters.createdTo||task.createdAt.slice(0,10)<=taskFilters.createdTo)&&(!taskFilters.creator||task.creatorName===taskFilters.creator)&&(!taskFilters.assignee||task.assigneeName===taskFilters.assignee)&&(!taskFilters.dueFrom||task.dueDate>=taskFilters.dueFrom)&&(!taskFilters.dueTo||task.dueDate<=taskFilters.dueTo)&&(!taskFilters.status||String(task.progress)===taskFilters.status)});
  return filtered.sort((a,b)=>{let left=a[sortState.key]??'',right=b[sortState.key]??'';if(typeof left==='string'){left=left.toLowerCase();right=String(right).toLowerCase();}const result=left<right?-1:left>right?1:0;return sortState.direction==='asc'?result:-result;});
}
function taskRow(task) {
  const status=task.progress===100?'Finalizada':`${task.progress}%`, statusControl=task.assigneeId===me.id?`<select data-id="${task.id}" aria-label="Cambiar estado">${statusOptions(task)}</select>`:`<span class="status-pill">${status}</span>`;
  const reading=task.acknowledgedAt?`<span class="read-ok">✓ Leída<br><small>${dateTimeText(task.acknowledgedAt)}</small></span>`:task.assigneeId===me.id?`<button class="acknowledge-task" data-id="${task.id}">Confirmar lectura</button>`:'<span class="read-pending">Pendiente</span>';
  const canNote=task.creatorId===me.id||task.assigneeId===me.id,actions=`${task.creatorId===me.id?`<button class="edit-task" data-id="${task.id}">Editar</button>`:''}`||'—';
  const latest=(task.notes||[]).length?task.notes[task.notes.length-1].text:task.description||'Sin descripción inicial';
  const description=`<div class="latest-note">${escapeHtml(latest)}</div>`;
  return `<tr class="${task.progress===100?'completed-row':''}"><td><strong>${escapeHtml(task.title)}</strong></td><td class="description-cell ${canNote?'can-comment':''}" data-task-id="${task.id}" tabindex="0" role="button" title="Doble clic para ver todo">${description}</td><td>${dateText(task.createdAt)}</td><td>${escapeHtml(task.creatorName)}</td><td>${escapeHtml(task.assigneeName)}</td><td>${dueDateText(task.dueDate)}</td><td>${statusControl}</td><td>${reading}</td><td class="row-actions">${actions}</td></tr>`;
}
function renderUsers() { $('#userList').innerHTML = users.map(user => `<div class="user-item ${user.active?'':'inactive'}"><div><strong>${escapeHtml(user.name)}</strong><span>@${escapeHtml(user.username)} · ${user.role === 'admin' ? 'Administrador' : 'Empleado'} · ${user.active?'Activo':'Desactivado'}</span></div>${me.role==='admin'?`<button class="edit-user" data-id="${user.id}">Editar</button>`:''}</div>`).join(''); $$('.edit-user').forEach(button=>button.addEventListener('click',()=>openEditUser(button.dataset.id))); }
function openEditUser(id) { const user=users.find(x=>x.id===id), form=$('#editUserForm'); if(!user)return; form.elements.id.value=user.id; form.elements.name.value=user.name; form.elements.username.value=user.username; form.elements.password.value=''; form.elements.role.value=user.role; form.elements.active.checked=user.active; form.querySelector('.formMessage').textContent=''; $('#editUserModal').classList.remove('hidden'); }
function closeEditUser() { $('#editUserModal').classList.add('hidden'); }
function openEditTask(id) { const task=tasks.find(x=>x.id===id),form=$('#editTaskForm'); if(!task)return; form.elements.id.value=task.id;form.elements.title.value=task.title;form.elements.assigneeId.value=task.assigneeId;form.elements.dueDate.value=task.dueDate||'';form.querySelector('.formMessage').textContent='';$('#editTaskModal').classList.remove('hidden'); }
function closeEditTask() { $('#editTaskModal').classList.add('hidden'); }
function openNote(id) { const form=$('#noteForm');form.elements.id.value=id;form.elements.text.value='';form.querySelector('.formMessage').textContent='';$('#noteModal').classList.remove('hidden'); }
function closeNote() { $('#noteModal').classList.add('hidden'); }
function openDescription(id) { const task=tasks.find(item=>item.id===id);if(!task)return;const initial=task.description?`<section><h3>Descripción inicial</h3><p>${escapeHtml(task.description)}</p></section>`:'<section><h3>Descripción inicial</h3><p>Sin descripción inicial</p></section>',notes=(task.notes||[]).map((note,index)=>`<section><h3>Observación ${index+1}</h3><p>${escapeHtml(note.text)}</p></section>`).join('');$('#descriptionHistory').innerHTML=initial+(notes||'<p class="no-description">No hay observaciones adicionales.</p>');$('#descriptionModal').classList.remove('hidden'); }
function closeDescription() { $('#descriptionModal').classList.add('hidden'); }
async function acknowledgeTask(id) { try { await request(`/api/tasks/${id}/acknowledge`,{method:'POST'});await refresh();toast('Lectura confirmada'); } catch(error){toast(error.message);} }
async function updateStatus(event) { try { await request(`/api/tasks/${event.target.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ progress: Number(event.target.value) }) }); await refresh(); toast('Estado actualizado'); } catch (error) { toast(error.message); await refresh(); } }
function showView(name, addHistory = true) { ['tasks','all','new','machines','users'].forEach(x => $(`#${x}View`).classList.toggle('hidden', x !== name)); $$('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === name)); $('#greeting').textContent = name === 'tasks' ? 'Tus tareas' : name === 'all' ? 'Todas las tareas' : name === 'new' ? 'Crear una tarea' : name === 'machines' ? 'Maquinarias' : 'Gestión del equipo'; const sameScreen=history.state?.view===name&&!history.state?.machineId;if(addHistory&&!sameScreen)history.pushState({view:name},'',`#${name}`);if(name==='machines')window.loadMachinery?.(); }
function closeInstall() { $('#installModal').classList.add('hidden'); }
function showDeviceInstructions(device) {
  const target=$('#deviceInstructions'); $$('.device-options button').forEach(button=>button.classList.toggle('active',button.dataset.device===device));
  if(device==='iphone') target.innerHTML='<h3>Instalar en iPhone</h3><ol><li>Abre esta dirección utilizando <strong>Safari</strong>.</li><li>Pulsa el botón <strong>Compartir</strong> (cuadrado con flecha).</li><li>Selecciona <strong>Añadir a pantalla de inicio</strong>.</li><li>Pulsa <strong>Añadir</strong> y abre el icono Avanza.</li></ol>';
  if(device==='android') target.innerHTML='<h3>Instalar en Android</h3><p>Pulsa el botón para instalar Avanza. Si no aparece la confirmación, abre el menú ⋮ de Chrome y selecciona <strong>Instalar aplicación</strong>.</p><button id="runInstall" class="primary" type="button">Instalar ahora</button>';
  if(device==='computer') target.innerHTML='<h3>Instalar en computadora</h3><p>En Chrome o Edge abre el menú del navegador y selecciona <strong>Instalar Avanza</strong> o <strong>Apps → Install Avanza</strong>.</p><button id="runInstall" class="primary" type="button">Instalar ahora</button>';
  $('#runInstall')?.addEventListener('click',async()=>{if(!installPrompt)return toast('Usa la opción Instalar aplicación del menú del navegador');installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;});
}
function urlBase64ToUint8Array(value) { const padding='='.repeat((4-value.length%4)%4),base64=(value+padding).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(base64);return Uint8Array.from([...raw].map(char=>char.charCodeAt(0))); }
async function enableNotifications() { if(!('serviceWorker'in navigator)||!('PushManager'in window)){return toast('Este navegador no admite notificaciones push');} try { const permission=await Notification.requestPermission();if(permission!=='granted')return toast('Permiso de notificaciones no concedido');const registration=await navigator.serviceWorker.ready,key=(await request('/api/push/public-key')).publicKey;const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(key)});await request('/api/push/subscribe',{method:'POST',body:JSON.stringify({subscription})});$('#enableNotifications').textContent='✓ Notificaciones activas';$('#enableNotifications').classList.add('enabled');toast('Notificaciones activadas'); } catch(error){toast(error.message||'No se pudieron activar las notificaciones');} }

$('#loginForm').addEventListener('submit', async event => { event.preventDefault(); $('#loginError').textContent=''; const input=Object.fromEntries(new FormData(event.target)); try { me=(await request('/api/login',{method:'POST',body:JSON.stringify(input)})).user; await enterApp(); } catch(error){ $('#loginError').textContent=error.message; } });
$('#installApp').addEventListener('click',()=>{$('#installModal').classList.remove('hidden');const detected=/iphone|ipad|ipod/i.test(navigator.userAgent)?'iphone':/android/i.test(navigator.userAgent)?'android':'computer';showDeviceInstructions(detected);});
$('#closeInstall').addEventListener('click',closeInstall);$('#installModal').addEventListener('click',event=>{if(event.target===$('#installModal'))closeInstall();});$$('.device-options button').forEach(button=>button.addEventListener('click',()=>showDeviceInstructions(button.dataset.device)));
$('#logout').addEventListener('click', async () => { await request('/api/logout',{method:'POST'}); location.reload(); });
$$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('#taskForm').addEventListener('submit', async event => { event.preventDefault(); const msg=event.target.querySelector('.formMessage'); msg.textContent=''; try { await request('/api/tasks',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); event.target.reset(); await refresh(); showView('tasks'); toast('Tarea creada y asignada'); } catch(error){msg.textContent=error.message;} });
$('#userForm').addEventListener('submit', async event => { event.preventDefault(); const msg=event.target.querySelector('.formMessage'); msg.textContent=''; try { await request('/api/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); event.target.reset(); await refresh(); toast('Usuario creado'); } catch(error){msg.textContent=error.message;} });
$('#closeEditUser').addEventListener('click', closeEditUser); $('#cancelEditUser').addEventListener('click', closeEditUser); $('#editUserModal').addEventListener('click', event=>{if(event.target===$('#editUserModal'))closeEditUser();});
$('#editUserForm').addEventListener('submit', async event => { event.preventDefault(); const form=event.target,msg=form.querySelector('.formMessage'),id=form.elements.id.value; msg.textContent=''; const payload={name:form.elements.name.value,username:form.elements.username.value,password:form.elements.password.value,role:form.elements.role.value,active:form.elements.active.checked}; try { await request(`/api/users/${id}`,{method:'PATCH',body:JSON.stringify(payload)}); closeEditUser(); toast('Perfil actualizado'); if(id===me.id){setTimeout(()=>location.reload(),500);}else{await refresh();} } catch(error){msg.textContent=error.message;} });
$('#closeEditTask').addEventListener('click', closeEditTask); $('#cancelEditTask').addEventListener('click', closeEditTask); $('#editTaskModal').addEventListener('click',event=>{if(event.target===$('#editTaskModal'))closeEditTask();});
$('#editTaskForm').addEventListener('submit', async event=>{event.preventDefault();const form=event.target,msg=form.querySelector('.formMessage'),id=form.elements.id.value;msg.textContent='';const payload={title:form.elements.title.value,assigneeId:form.elements.assigneeId.value,dueDate:form.elements.dueDate.value};try{await request(`/api/tasks/${id}`,{method:'PATCH',body:JSON.stringify(payload)});closeEditTask();await refresh();toast('Tarea actualizada');}catch(error){msg.textContent=error.message;}});
$('#closeNote').addEventListener('click',closeNote);$('#cancelNote').addEventListener('click',closeNote);$('#noteModal').addEventListener('click',event=>{if(event.target===$('#noteModal'))closeNote();});
$('#closeDescription').addEventListener('click',closeDescription);$('#descriptionModal').addEventListener('click',event=>{if(event.target===$('#descriptionModal'))closeDescription();});
$('#noteForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.target,msg=form.querySelector('.formMessage'),id=form.elements.id.value;msg.textContent='';try{await request(`/api/tasks/${id}/notes`,{method:'POST',body:JSON.stringify({text:form.elements.text.value})});closeNote();await refresh();toast('Anotación agregada');}catch(error){msg.textContent=error.message;}});
$('#enableNotifications').addEventListener('click',enableNotifications);
window.addEventListener('popstate', event => { if (!me) return; const state = event.state || { view: 'tasks' }; showView(state.view || 'tasks', false); if (state.view === 'machines') setTimeout(() => window.openMachineFromHistory?.(state.machineId || null), 0); });
boot();
