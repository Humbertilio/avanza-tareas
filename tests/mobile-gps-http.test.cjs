const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
test('mobile HTTP enforces seller access, atomic batches, retries and native journey ownership',async()=>{
 fs.mkdirSync(path.resolve('tmp'),{recursive:true});process.env.AVANZA_DATA_DIR=fs.mkdtempSync(path.resolve('tmp/mobile-http-'));process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.ADMIN_PASSWORD='MobileTest123!';
 const {server,readDb}=require('../server');if(!server.listening)await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(route,data,headers={})=>{const response=await fetch(base+route,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json(),headers:response.headers};};
 try{
  const admin=await call('/api/login',{username:'admin',password:'MobileTest123!'});assert.equal(admin.status,200);const Cookie=admin.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/users',{name:'GPS Seller',username:'gps.seller',password:'1234',role:'seller'},{Cookie})).status,201);
  const deviceId=randomUUID();assert.equal((await call('/api/mobile/login',{username:'admin',password:'MobileTest123!',deviceId})).status,403);
  assert.equal((await call('/api/mobile/status')).status,401);
  const login=await call('/api/mobile/login',{username:'gps.seller',password:'1234',deviceId});assert.equal(login.status,200);const headers={Authorization:`Bearer ${login.body.token}`};
  const sessionId=randomUUID(),recordedAt=new Date(Date.now()-60000).toISOString(),start={id:randomUUID(),sessionId,recordedAt,type:'start'},point={id:randomUUID(),sessionId,type:'point',recordedAt,latitude:19,longitude:-70,accuracy:10};
  assert.equal((await call('/api/mobile/sync',{events:[start,{...point,latitude:100}]},headers)).status,422);
  assert.ok(!readDb().trackingSessions.some(s=>s.id===sessionId),'failed batch must not persist its start');
  assert.equal((await call('/api/mobile/sync',{events:[start,point]},headers)).status,200);
  assert.equal((await call('/api/mobile/sync',{events:[start,point]},headers)).status,200);assert.equal(readDb().locationPoints.filter(p=>p.sessionId===sessionId).length,1);
  const browser=await call('/api/login',{username:'gps.seller',password:'1234'});const sellerCookie=browser.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/tracking/stop',{}, {Cookie:sellerCookie})).status,409);
  assert.equal((await call('/api/tracking/location',{latitude:19,longitude:-70,accuracy:10},{Cookie:sellerCookie})).status,409);
  const other=await call('/api/mobile/login',{username:'gps.seller',password:'1234',deviceId:randomUUID()});assert.equal((await call('/api/mobile/sync',{events:[{...point,id:randomUUID()}]},{Authorization:`Bearer ${other.body.token}`})).status,403);
  const stop={id:randomUUID(),sessionId,type:'stop',recordedAt:new Date().toISOString()};assert.equal((await call('/api/mobile/sync',{events:[stop]},headers)).status,200);assert.equal((await call('/api/mobile/status',null,headers)).body.session,null);
  assert.equal((await call('/api/mobile/logout',{},headers)).status,200);assert.equal((await call('/api/mobile/status',null,headers)).status,401);
 }finally{await new Promise(r=>server.close(r));}
});
