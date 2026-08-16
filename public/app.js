const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let me = null, users = [], tasks = [], filter = 'open', installPrompt = null;

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('#installApp').classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#installApp').classList.add('hidden'); toast('Avanza quedó instalada'); });

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación');
  return data;
}
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 2600); }
function initials(name) { return name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(); }
function dateText(value) { return new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)); }

async function boot() {
  try { me = (await request('/api/me')).user; await enterApp(); }
  catch { $('#loginView').classList.remove('hidden'); }
}
async function enterApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#profileName').textContent = me.name; $('#profileRole').textContent = me.role === 'admin' ? 'Administrador' : 'Empleado'; $('#avatar').textContent = initials(me.name);
  if (me.role === 'admin') $('#usersNav').classList.remove('hidden');
  await refresh();
}
async function refresh() {
  [users, tasks] = await Promise.all([request('/api/users').then(x => x.users), request('/api/tasks').then(x => x.tasks)]);
  $('#assigneeSelect').innerHTML = '<option value="">Selecciona un empleado</option>' + users.map(x => `<option value="${x.id}">${escapeHtml(x.name)} · @${escapeHtml(x.username)}</option>`).join('');
  renderTasks(); renderUsers();
}
function escapeHtml(value) { const el = document.createElement('span'); el.textContent = value || ''; return el.innerHTML; }
function renderTasks() {
  const assigned = tasks.filter(x => x.assigneeId === me.id);
  $('#assignedCount').textContent = assigned.length; $('#progressCount').textContent = assigned.filter(x => x.progress < 100).length; $('#doneCount').textContent = assigned.filter(x => x.progress === 100).length;
  let shown = filter === 'created' ? tasks.filter(x => x.creatorId === me.id) : assigned.filter(x => filter === 'done' ? x.progress === 100 : x.progress < 100);
  $('#taskList').innerHTML = shown.length ? shown.map(taskCard).join('') : '<div class="empty">No hay tareas en esta sección.</div>';
  $$('.task select').forEach(select => select.addEventListener('change', updateStatus));
}
function taskCard(task) {
  const mine = task.assigneeId === me.id;
  const status = task.progress === 100 ? 'Finalizada' : `${task.progress}%`;
  return `<article class="task"><div><h3>${escapeHtml(task.title)}</h3>${task.description ? `<p>${escapeHtml(task.description)}</p>` : ''}<div class="meta">Asignada a <b>${escapeHtml(task.assigneeName)}</b> · Creada por ${escapeHtml(task.creatorName)} · ${dateText(task.createdAt)}</div><div class="progress-row"><div class="track"><i style="width:${task.progress}%"></i></div><strong>${status}</strong></div></div><div class="status-control">${mine ? `<select data-id="${task.id}" aria-label="Cambiar estado"><option value="25" ${task.progress===25?'selected':''}>25%</option><option value="50" ${task.progress===50?'selected':''}>50%</option><option value="75" ${task.progress===75?'selected':''}>75%</option><option value="100" ${task.progress===100?'selected':''}>Finalizada</option></select>` : `<span class="status-pill">${status}</span>`}</div></article>`;
}
function renderUsers() { $('#userList').innerHTML = users.map(user => `<div class="user-item"><strong>${escapeHtml(user.name)}</strong><span>@${escapeHtml(user.username)} · ${user.role === 'admin' ? 'Administrador' : 'Empleado'}</span></div>`).join(''); }
async function updateStatus(event) { try { await request(`/api/tasks/${event.target.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ progress: Number(event.target.value) }) }); await refresh(); toast('Estado actualizado'); } catch (error) { toast(error.message); await refresh(); } }
function showView(name) { ['tasks','new','users'].forEach(x => $(`#${x}View`).classList.toggle('hidden', x !== name)); $$('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === name)); $('#greeting').textContent = name === 'tasks' ? `Hola, ${me.name.split(' ')[0]}` : name === 'new' ? 'Crear una tarea' : 'Gestión del equipo'; }

$('#loginForm').addEventListener('submit', async event => { event.preventDefault(); $('#loginError').textContent=''; const input=Object.fromEntries(new FormData(event.target)); try { me=(await request('/api/login',{method:'POST',body:JSON.stringify(input)})).user; await enterApp(); } catch(error){ $('#loginError').textContent=error.message; } });
$('#installApp').addEventListener('click', async () => { const help=$('#installHelp'); if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installApp').classList.add('hidden');return;} help.textContent=/iphone|ipad|ipod/i.test(navigator.userAgent)?'En iPhone: pulsa Compartir y luego “Añadir a pantalla de inicio”.':'Abre el menú del navegador y selecciona “Instalar aplicación” o “Añadir a pantalla principal”.';help.classList.remove('hidden'); });
$('#logout').addEventListener('click', async () => { await request('/api/logout',{method:'POST'}); location.reload(); });
$$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$$('.filter').forEach(button => button.addEventListener('click', () => { filter=button.dataset.filter; $$('.filter').forEach(x=>x.classList.toggle('active',x===button)); renderTasks(); }));
$('#taskForm').addEventListener('submit', async event => { event.preventDefault(); const msg=event.target.querySelector('.formMessage'); msg.textContent=''; try { await request('/api/tasks',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); event.target.reset(); await refresh(); filter='open'; showView('tasks'); toast('Tarea creada y asignada'); } catch(error){msg.textContent=error.message;} });
$('#userForm').addEventListener('submit', async event => { event.preventDefault(); const msg=event.target.querySelector('.formMessage'); msg.textContent=''; try { await request('/api/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); event.target.reset(); await refresh(); toast('Empleado creado'); } catch(error){msg.textContent=error.message;} });
boot();
