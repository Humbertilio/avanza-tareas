(() => {
  let machineMe = null, machineUsers = [], machines = [], machineTasks = [];
  const q = selector => document.querySelector(selector);
  const qa = selector => [...document.querySelectorAll(selector)];
  const esc = value => { const node=document.createElement('span');node.textContent=value||'';return node.innerHTML; };
  const mRequest = async (url, options={}) => { const response=await fetch(url,{headers:{'Content-Type':'application/json'},...options});const data=await response.json();if(!response.ok)throw new Error(data.error||'No se pudo completar la operación');return data; };
  const mToast = message => { const node=q('#toast');node.textContent=message;node.classList.add('show');setTimeout(()=>node.classList.remove('show'),2600); };
  const date = value => { if(!value)return 'Sin fecha';const [y,m,d]=value.split('-');return `${d}/${m}/${y}`; };
  const statusOptions = task => [0,25,50,75,100].map(value=>`<option value="${value}" ${task.progress===value?'selected':''}>${value===100?'Finalizada':value+'%'}</option>`).join('');

  async function loadMachinery() {
    try {
      const [meData,userData,machineData,taskData]=await Promise.all([mRequest('/api/me'),mRequest('/api/users'),mRequest('/api/machines'),mRequest('/api/machine-tasks')]);
      machineMe=meData.user;machineUsers=userData.users.sort((a,b)=>a.name.localeCompare(b.name,'es',{sensitivity:'base'}));machines=machineData.machines.sort((a,b)=>a.name.localeCompare(b.name,'es',{sensitivity:'base'}));machineTasks=taskData.machineTasks;
      q('#newMachine').classList.toggle('hidden',machineMe.role!=='admin');
      renderMachines();fillOptions();
    } catch(error){mToast(error.message);}
  }
  window.loadMachinery=loadMachinery;

  function fillOptions(){
    const users=machineUsers.filter(user=>user.active).map(user=>`<option value="${user.id}">${esc(user.name)}</option>`).join('');
    q('#machineForm select[name="responsibleId"]').innerHTML='<option value="">Selecciona un empleado</option>'+users;
    q('#machineTaskForm select[name="machineId"]').innerHTML='<option value="">Selecciona una maquinaria</option>'+machines.map(machine=>`<option value="${machine.id}">${esc(machine.name)} — ${esc(machine.responsibleName)}</option>`).join('');
  }

  function renderMachines(){
    q('#machineList').innerHTML=machines.length?machines.map(machineCard).join(''):'<div class="machine-empty">Todavía no hay maquinarias registradas.</div>';
    qa('.edit-machine').forEach(button=>button.addEventListener('click',()=>openMachine(button.dataset.id)));
    qa('.delete-machine').forEach(button=>button.addEventListener('click',()=>deleteMachine(button.dataset.id)));
    qa('.machine-status').forEach(select=>select.addEventListener('change',updateMachineStatus));
    qa('.machine-ack').forEach(button=>button.addEventListener('click',()=>acknowledgeMachineTask(button.dataset.id)));
    qa('.machine-note').forEach(button=>button.addEventListener('click',()=>openMachineNote(button.dataset.id)));
  }

  function machineCard(machine){
    const rows=machineTasks.filter(task=>task.machineId===machine.id);
    const actions=machineMe.role==='admin'?`<div class="machine-actions"><button class="edit-machine" data-id="${machine.id}">Editar</button><button class="delete-machine danger" data-id="${machine.id}">Eliminar</button></div>`:'';
    return `<article class="machine-card"><div class="machine-card-head"><div><h3>${esc(machine.name)}</h3><p>Responsable: <strong>${esc(machine.responsibleName)}</strong> · ${rows.length} tarea${rows.length===1?'':'s'}</p></div>${actions}</div><div class="machine-table-wrap">${rows.length?`<table class="machine-table"><thead><tr><th>Tarea</th><th>Descripción</th><th>Creada por</th><th>Terminación</th><th>Estado</th><th>Lectura</th><th>Acciones</th></tr></thead><tbody>${rows.map(machineTaskRow).join('')}</tbody></table>`:'<div class="machine-empty">Esta maquinaria no tiene tareas.</div>'}</div></article>`;
  }

  function machineTaskRow(task){
    const latest=(task.notes||[]).length?task.notes[task.notes.length-1].text:task.description||'Sin descripción';
    const history=[task.description,...(task.notes||[]).map(note=>note.text)].filter(Boolean).map((text,index)=>`${index?`Observación ${index}`:'Descripción inicial'}: ${text}`).join('\n\n');
    const status=task.assigneeId===machineMe.id?`<select class="machine-status" data-id="${task.id}">${statusOptions(task)}</select>`:`${task.progress===100?'Finalizada':task.progress+'%'}`;
    const reading=task.acknowledgedAt?'✓ Leída':task.assigneeId===machineMe.id?`<button class="machine-ack" data-id="${task.id}">Confirmar</button>`:'Pendiente';
    const canNote=task.creatorId===machineMe.id||task.assigneeId===machineMe.id;
    return `<tr class="${task.progress===100?'machine-task-done':''}"><td><strong>${esc(task.title)}</strong></td><td class="machine-description"><details><summary>${esc(latest)}</summary><div class="history">${esc(history)}</div></details></td><td>${esc(task.creatorName)}</td><td>${date(task.dueDate)}</td><td>${status}</td><td class="machine-read">${reading}</td><td class="machine-task-actions">${canNote?`<button class="machine-note" data-id="${task.id}">Comentar</button>`:'—'}</td></tr>`;
  }

  function openMachine(id='') { const form=q('#machineForm');form.reset();form.elements.id.value=id;if(id){const machine=machines.find(item=>item.id===id);form.elements.name.value=machine.name;form.elements.responsibleId.value=machine.responsibleId;}q('#machineModal').classList.remove('hidden'); }
  function openMachineTask(){if(!machines.length)return mToast('El ADMIN debe registrar primero una maquinaria');q('#machineTaskForm').reset();q('#machineTaskModal').classList.remove('hidden');}
  function openMachineNote(id){const form=q('#machineNoteForm');form.reset();form.elements.id.value=id;q('#machineNoteModal').classList.remove('hidden');}
  function close(id){q('#'+id).classList.add('hidden');}

  async function deleteMachine(id){const machine=machines.find(item=>item.id===id);if(!confirm(`¿Eliminar ${machine.name} y todas sus tareas de maquinaria?`))return;try{await mRequest(`/api/machines/${id}`,{method:'DELETE'});await loadMachinery();mToast('Maquinaria eliminada');}catch(error){mToast(error.message);}}
  async function acknowledgeMachineTask(eventId){try{await mRequest(`/api/machine-tasks/${eventId}/acknowledge`,{method:'POST'});await loadMachinery();mToast('Lectura confirmada');}catch(error){mToast(error.message);}}
  async function updateMachineStatus(event){try{await mRequest(`/api/machine-tasks/${event.target.dataset.id}/status`,{method:'PATCH',body:JSON.stringify({progress:Number(event.target.value)})});await loadMachinery();mToast('Estado actualizado');}catch(error){mToast(error.message);await loadMachinery();}}

  q('#newMachine').addEventListener('click',()=>openMachine());q('#newMachineTask').addEventListener('click',openMachineTask);
  qa('[data-close]').forEach(button=>button.addEventListener('click',()=>close(button.dataset.close)));
  q('#machineForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.target,id=form.elements.id.value,payload={name:form.elements.name.value,responsibleId:form.elements.responsibleId.value};try{await mRequest(id?`/api/machines/${id}`:'/api/machines',{method:id?'PATCH':'POST',body:JSON.stringify(payload)});close('machineModal');await loadMachinery();mToast(id?'Maquinaria actualizada':'Maquinaria creada');}catch(error){form.querySelector('.formMessage').textContent=error.message;}});
  q('#machineTaskForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;try{await mRequest('/api/machine-tasks',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});close('machineTaskModal');await loadMachinery();mToast('Tarea de maquinaria creada');}catch(error){form.querySelector('.formMessage').textContent=error.message;}});
  q('#machineNoteForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.target,id=form.elements.id.value;try{await mRequest(`/api/machine-tasks/${id}/notes`,{method:'POST',body:JSON.stringify({text:form.elements.text.value})});close('machineNoteModal');await loadMachinery();mToast('Observación agregada');}catch(error){form.querySelector('.formMessage').textContent=error.message;}});
})();
