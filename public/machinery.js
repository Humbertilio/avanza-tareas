(() => {
  let machineMe=null,machineUsers=[],machines=[],machineTasks=[],selectedMachineId=null;
  const q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)];
  const esc=v=>{const n=document.createElement('span');n.textContent=v||'';return n.innerHTML;};
  const api=async(url,options={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...options}),d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo completar la operación');return d;};
  const toast=m=>{const n=q('#toast');n.textContent=m;n.classList.add('show');setTimeout(()=>n.classList.remove('show'),2600);};
  const date=v=>{if(!v)return 'Sin fecha';const[y,m,d]=v.split('-');return`${d}/${m}/${y}`;};
  const byName=(a,b)=>a.name.localeCompare(b.name,'es',{sensitivity:'base'});

  async function loadMachinery(){try{const[meData,userData,machineData,taskData]=await Promise.all([api('/api/me'),api('/api/users'),api('/api/machines'),api('/api/machine-tasks')]);machineMe=meData.user;machineUsers=userData.users.sort(byName);machines=machineData.machines.sort(byName);machineTasks=taskData.machineTasks;renderIndex();if(selectedMachineId&&machines.some(x=>x.id===selectedMachineId)){showDetail();renderDetail(selectedMachineId);}else showIndex();fillResponsibleOptions();}catch(error){toast(error.message);}}
  window.loadMachinery=loadMachinery;

  function renderIndex(){
    const rows=machines.map(machine=>`<tr><td><button class="machine-link" data-id="${machine.id}">${esc(machine.name)}</button></td><td>${machineMe.role==='admin'?`<button class="edit-machine" data-id="${machine.id}">Modificar</button> <button class="delete-machine danger" data-id="${machine.id}">Eliminar</button>`:'—'}</td></tr>`).join('');
    const add=machineMe.role==='admin'?'<tr class="add-machine-row"><td colspan="2"><button id="newMachine" type="button">＋ Agregar nueva maquinaria</button></td></tr>':'';
    q('#machineList').innerHTML=`<div class="machine-index-wrap"><table class="machine-index-table"><thead><tr><th>Nombre del equipo</th><th>Acciones</th></tr></thead><tbody>${rows||'<tr><td colspan="2" class="machine-empty">No hay maquinarias registradas.</td></tr>'}${add}</tbody></table></div>`;
    qa('.machine-link').forEach(b=>b.addEventListener('click',()=>openDetail(b.dataset.id)));qa('.edit-machine').forEach(b=>b.addEventListener('click',()=>openMachine(b.dataset.id)));qa('.delete-machine').forEach(b=>b.addEventListener('click',()=>deleteMachine(b.dataset.id)));q('#newMachine')?.addEventListener('click',()=>openMachine());
  }

  function openDetail(id){selectedMachineId=id;showDetail();renderDetail(id);}
  function showIndex(){q('#machineIndex').classList.remove('hidden');q('#machineDetail').classList.add('hidden');}
  function showDetail(){q('#machineIndex').classList.add('hidden');q('#machineDetail').classList.remove('hidden');}
  function renderDetail(id){
    const machine=machines.find(x=>x.id===id);if(!machine)return showIndex();const tasks=machineTasks.filter(x=>x.machineId===id);
    q('#machineDetail').innerHTML=`<div class="machine-detail-head"><div><button id="backMachines" class="back-machines" type="button">← Maquinarias</button><h2>${esc(machine.name)}</h2><p>Responsable: <strong>${esc(machine.responsibleName)}</strong></p></div><button id="addMachineTask" class="primary" type="button">＋ Agregar tarea</button></div><div class="machine-table-wrap">${tasks.length?`<table class="machine-table"><thead><tr><th>Tarea</th><th>Descripción</th><th>Creada por</th><th>Terminación</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${tasks.map(taskRow).join('')}</tbody></table>`:'<div class="machine-empty">Esta maquinaria todavía no tiene tareas.</div>'}</div>`;
    q('#backMachines').addEventListener('click',()=>{selectedMachineId=null;showIndex();});q('#addMachineTask').addEventListener('click',()=>openTask('',id));qa('.finish-machine-task').forEach(b=>b.addEventListener('click',()=>finishTask(b.dataset.id)));qa('.edit-machine-task').forEach(b=>b.addEventListener('click',()=>openTask(b.dataset.id,id)));qa('.machine-note').forEach(b=>b.addEventListener('click',()=>openNote(b.dataset.id)));
  }

  function taskRow(task){
    const latest=(task.notes||[]).length?task.notes[task.notes.length-1].text:task.description||'Sin descripción',history=[task.description,...(task.notes||[]).map(n=>n.text)].filter(Boolean).join('\n\n'),canEdit=task.creatorId===machineMe.id||machineMe.role==='admin',canNote=task.creatorId===machineMe.id||task.assigneeId===machineMe.id;
    const finish=task.progress===100?'<span class="finished-label">Finalizada</span>':task.assigneeId===machineMe.id?`<button class="finish-machine-task" data-id="${task.id}">Finalizar</button>`:'Pendiente';
    return `<tr class="${task.progress===100?'machine-task-done':''}"><td><strong>${esc(task.title)}</strong></td><td class="machine-description"><details><summary>${esc(latest)}</summary><div class="history">${esc(history)}</div></details></td><td>${esc(task.creatorName)}</td><td>${date(task.dueDate)}</td><td>${finish}</td><td class="machine-task-actions">${canEdit&&task.progress!==100?`<button class="edit-machine-task" data-id="${task.id}">Modificar</button>`:''}${canNote&&task.progress!==100?`<button class="machine-note" data-id="${task.id}">Comentar</button>`:''}</td></tr>`;
  }

  function fillResponsibleOptions(){q('#machineForm select[name="responsibleId"]').innerHTML='<option value="">Selecciona un empleado</option>'+machineUsers.filter(x=>x.active).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');}
  function openMachine(id=''){const f=q('#machineForm');f.reset();f.elements.id.value=id;f.querySelector('.formMessage').textContent='';if(id){const m=machines.find(x=>x.id===id);f.elements.name.value=m.name;f.elements.responsibleId.value=m.responsibleId;}q('#machineModal').classList.remove('hidden');}
  function openTask(id='',machineId=selectedMachineId){const f=q('#machineTaskForm');f.reset();f.elements.id.value=id;f.elements.machineId.value=machineId;f.querySelector('.formMessage').textContent='';q('#machineTaskModalTitle').textContent=id?'Modificar tarea de maquinaria':'Nueva tarea de maquinaria';if(id){const t=machineTasks.find(x=>x.id===id);f.elements.title.value=t.title;f.elements.description.value=t.description||'';f.elements.dueDate.value=t.dueDate;}q('#machineTaskModal').classList.remove('hidden');}
  function openNote(id){const f=q('#machineNoteForm');f.reset();f.elements.id.value=id;f.querySelector('.formMessage').textContent='';q('#machineNoteModal').classList.remove('hidden');}
  const close=id=>q('#'+id).classList.add('hidden');

  async function deleteMachine(id){const m=machines.find(x=>x.id===id);if(!confirm(`¿Eliminar ${m.name} y todas sus tareas?`))return;try{await api(`/api/machines/${id}`,{method:'DELETE'});selectedMachineId=null;await loadMachinery();toast('Maquinaria eliminada');}catch(error){toast(error.message);}}
  async function finishTask(id){if(!confirm('¿Confirmas que esta tarea fue finalizada?'))return;try{await api(`/api/machine-tasks/${id}/status`,{method:'PATCH',body:JSON.stringify({progress:100})});await loadMachinery();toast('Tarea finalizada');}catch(error){toast(error.message);}}

  qa('[data-close]').forEach(b=>b.addEventListener('click',()=>close(b.dataset.close)));
  q('#machineForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,id=f.elements.id.value;try{await api(id?`/api/machines/${id}`:'/api/machines',{method:id?'PATCH':'POST',body:JSON.stringify({name:f.elements.name.value,responsibleId:f.elements.responsibleId.value})});close('machineModal');await loadMachinery();toast(id?'Maquinaria modificada':'Maquinaria agregada');}catch(error){f.querySelector('.formMessage').textContent=error.message;}});
  q('#machineTaskForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,id=f.elements.id.value,payload={machineId:f.elements.machineId.value,title:f.elements.title.value,description:f.elements.description.value,dueDate:f.elements.dueDate.value};try{await api(id?`/api/machine-tasks/${id}`:'/api/machine-tasks',{method:id?'PATCH':'POST',body:JSON.stringify(payload)});close('machineTaskModal');await loadMachinery();toast(id?'Tarea modificada':'Tarea agregada');}catch(error){f.querySelector('.formMessage').textContent=error.message;}});
  q('#machineNoteForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;try{await api(`/api/machine-tasks/${f.elements.id.value}/notes`,{method:'POST',body:JSON.stringify({text:f.elements.text.value})});close('machineNoteModal');await loadMachinery();toast('Observación agregada');}catch(error){f.querySelector('.formMessage').textContent=error.message;}});
})();
