const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {applyOperation,clients}=require('../field-visits');
test('offline client, arrival and finish persist, survive reload, and sync after a lost response',async()=>{
  const storage=new Map(),user={id:'seller-a',role:'seller'};
  const db={companies:[],users:[user]};let online=false,loseResponse=true;
  const source=fs.readFileSync('public/visits.js','utf8').replaceAll('render();','void 0;').replace('window.loadVisits=','window.outbox={enqueue,sync,read,projected};window.loadVisits=');
  function load(){const window={addEventListener(){}};const context={window,document:{querySelector:()=>null},escapeHtml:s=>s,me:user,navigator:{onLine:false},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},crypto,structuredClone,AbortSignal,setInterval(){},setTimeout,console,fetch:async(url,options)=>{
    if(!online)throw new TypeError('offline');
    if(options.method==='POST'){const op=JSON.parse(options.body);applyOperation(db,user,op);if(loseResponse){loseResponse=false;throw new TypeError('response lost');}return {ok:true,json:async()=>({ok:true})};}
    return {ok:true,json:async()=>({clients:clients(db),visits:db.fieldVisits||[],sellers:[user],lastVisits:{},downloadedAt:new Date().toISOString()})};
  }};vm.runInNewContext(source,context);return window.outbox;}
  let app=load();const id=crypto.randomUUID(),visitId=crypto.randomUUID(),at='2026-01-01T12:00:00.000Z';
  await app.enqueue('client',{id,name:'Sin señal',point:{latitude:-16,longitude:-68},createdAt:at});await new Promise(setImmediate);
  await app.enqueue('arrival',{id:visitId,clientId:id,arrivedAt:at,point:null});await new Promise(setImmediate);
  await app.enqueue('finish',{id:visitId,endedAt:'2026-01-01T12:10:00.000Z',result:'Sin pedido'});await new Promise(setImmediate);
  assert.equal(app.read().pending.length,3);assert.equal(app.projected(app.read()).visits[0].result,'Sin pedido');
  app=load();assert.equal(app.read().pending.length,3);online=true;await app.sync();assert.equal(app.read().pending.length,3);await app.sync();assert.equal(app.read().pending.length,0);assert.equal(db.companies.length,1);assert.equal(db.fieldVisits.length,1);assert.equal(db.fieldVisits[0].arrivedAt,at);assert.equal(app.read().visits[0].result,'Sin pedido');
});
