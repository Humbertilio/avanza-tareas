/* A single cancellable confirmation shared by task screens. */
(() => {
  let pending = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'task-delete-dialog';
  dialog.innerHTML = '<form method="dialog"><h2>Eliminar tarea</h2><p id="deleteTaskSummary"></p><p>Esta acción no se puede deshacer.</p><div class="modal-actions"><button value="cancel" autofocus>Cancelar</button><button value="delete" class="danger">Eliminar tarea</button></div></form>';
  dialog.setAttribute('aria-labelledby','deleteTaskSummary');
  document.body.append(dialog);
  dialog.addEventListener('close', () => { const resolve = pending; pending = null; resolve?.(dialog.returnValue === 'delete'); });
  window.cancelTaskDeletion = () => { if(dialog.open)dialog.close('cancel'); };
  window.confirmTaskDeletion = title => {
    if(pending)return Promise.resolve(false);
    dialog.querySelector('#deleteTaskSummary').textContent = `¿Eliminar «${title}» definitivamente?`;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {pending=resolve;dialog.showModal();});
  };
})();
