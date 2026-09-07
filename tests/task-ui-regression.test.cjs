const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('reloading machinery never binds task screen rows or double-tap deletion',async()=>{
 const ordinary={count:0,addEventListener(){this.count++;}},machine={events:[],addEventListener(name){this.events.push(name);}},nodes=new Map();
 const node=()=>({classList:{add(){},remove(){},contains(){return true;}},addEventListener(){},querySelector(){return node();},elements:{},innerHTML:''});
 const document={querySelector(s){if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);},querySelectorAll(s){if(s==='[data-task-id]')return [ordinary];if(s==='#machineIndex .compact-machine-task[data-task-id]')return [machine];return [];},addEventListener(){}};
 const window={};vm.runInNewContext(fs.readFileSync('public/machinery.js','utf8'),{document,window,setTimeout,Date,fetch:async url=>({ok:true,json:async()=>url==='/api/me'?{user:{role:'admin'}}:url==='/api/users'?{users:[]}:url==='/api/machines'?{machines:[]}:{machineTasks:[]}})});
 for(let i=0;i<12;i++)await window.loadMachinery();assert.equal(ordinary.count,0);assert.ok(!machine.events.includes('dblclick'));assert.ok(!machine.events.includes('touchend'));
});
test('task deletion cancellation settles once and permits a fresh confirmation',async()=>{
 class Dialog extends EventTarget{open=false;returnValue='';summary={textContent:''};querySelector(){return this.summary;}showModal(){this.open=true;}close(value){this.returnValue=value;this.open=false;this.dispatchEvent(new Event('close'));}}
 const dialog=new Dialog(),window={};vm.runInNewContext(fs.readFileSync('public/task-delete-dialog.js','utf8'),{window,document:{createElement:()=>Object.assign(dialog,{setAttribute(){}}),body:{append(){}}},Promise});
 const first=window.confirmTaskDeletion('Revisar motor');assert.match(dialog.summary.textContent,/Revisar motor/);assert.equal(await window.confirmTaskDeletion('Otra tarea'),false);window.cancelTaskDeletion();assert.equal(await first,false);assert.equal(dialog.open,false);
 const next=window.confirmTaskDeletion('Otra tarea');dialog.close('delete');assert.equal(await next,true);
});
