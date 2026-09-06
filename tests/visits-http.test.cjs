const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
test('authenticated HTTP flow and offline shell assets',async()=>{
  fs.mkdirSync(path.resolve('tmp'), {recursive:true});
  const data=fs.mkdtempSync(path.resolve('tmp/visits-http-'));
  process.env.AVANZA_DATA_DIR=data;process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.ADMIN_PASSWORD='VisitTest123!';
  const {server}=require('../server');
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    let response=await fetch(base+'/api/field/data');assert.equal(response.status,401);
    response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'VisitTest123!'})});assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const send=op=>fetch(base+'/api/field/sync',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(op)});
    const id=randomUUID(),at=new Date().toISOString();const operation={id:randomUUID(),type:'client',data:{id,name:'Cliente HTTP',point:{latitude:-16,longitude:-68},createdAt:at}};
    assert.equal((await send(operation)).status,200);assert.equal((await send(operation)).status,200);
    response=await fetch(base+'/api/field/data',{headers:{Cookie:cookie}});const payload=await response.json();assert.equal(payload.clients.length,1);
    const shell=await (await fetch(base+'/service-worker.js')).text();const assets=JSON.parse('['+shell.match(/ASSETS=\[(.*?)\]/)[1].replaceAll("'",'"')+']');
    for(const asset of assets)assert.equal((await fetch(base+asset)).status,200,asset);
  }finally{await new Promise(r=>server.close(r));}
});
