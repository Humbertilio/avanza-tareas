'use strict';
const crypto=require('node:crypto');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=(text,status=400)=>{throw Object.assign(new Error(text),{status});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
function authenticate(db,token){
 const credential=(db.mobileTokens||[]).find(t=>t.hash===digest(token)&&Date.parse(t.expiresAt)>Date.now());
 const user=credential&&db.users.find(u=>u.id===credential.userId&&u.active&&u.role==='seller'&&digest(u.passwordHash)===credential.passwordVersion);
 if(!user)fail('Inicie sesión con una cuenta de vendedor activa',401);
 return {user,credential};
}
function syncEvents(db,user,credential,input){
 if(!Array.isArray(input.events)||!input.events.length||input.events.length>200)fail('Envíe entre 1 y 200 registros');
 db.mobileEventReceipts||=[];
 const accepted=[],now=Date.now(),cutoff=now-30*86400000;
 for(const e of input.events){
  if(!e||!uuid(e.id)||!uuid(e.sessionId)||!['start','point','stop'].includes(e.type))fail('Registro no válido');
  const previous=db.mobileEventReceipts.find(r=>r.id===e.id&&r.userId===user.id&&r.deviceId===credential.deviceId);
  if(previous){if(previous.hash!==digest(JSON.stringify(e)))fail('Identificador de registro reutilizado',409);accepted.push(e.id);continue;}
  const timestamp=Date.parse(e.recordedAt);
  if(!Number.isFinite(timestamp)||timestamp>now+120000||timestamp<cutoff)fail('Fecha fuera del período permitido de 30 días',422);
  let session=db.trackingSessions.find(s=>s.id===e.sessionId);
  if(e.type==='start'){
   if(session)fail('Identificador de jornada existente',409);
   if(db.trackingSessions.some(s=>s.userId===user.id&&!s.endedAt))fail('Ya tiene una jornada abierta. Finalícela antes de iniciar otra.',409);
   session={id:e.sessionId,userId:user.id,deviceId:credential.deviceId,source:'android',sampleIntervalMs:300000,startedAt:new Date(timestamp).toISOString(),endedAt:null};
   db.trackingSessions.push(session);
  }else{
   if(!session||session.userId!==user.id||session.deviceId!==credential.deviceId)fail('La jornada no pertenece a este dispositivo',403);
   if(timestamp<Date.parse(session.startedAt))fail('El registro es anterior a la jornada',422);
   if(session.endedAt&&timestamp>Date.parse(session.endedAt))fail('La jornada ya está cerrada',409);
   if(e.type==='point'){
    if(!Number.isFinite(e.latitude)||Math.abs(e.latitude)>90||!Number.isFinite(e.longitude)||Math.abs(e.longitude)>180||!Number.isFinite(e.accuracy)||e.accuracy<0||e.accuracy>100000)fail('Ubicación no válida',422);
    db.locationPoints.push({id:e.id,sessionId:session.id,userId:user.id,latitude:e.latitude,longitude:e.longitude,accuracy:Math.round(e.accuracy),recordedAt:new Date(timestamp).toISOString(),receivedAt:new Date(now).toISOString(),source:'android'});
   }else{
    if(db.locationPoints.some(p=>p.sessionId===session.id&&Date.parse(p.recordedAt)>timestamp))fail('El cierre es anterior al último GPS',422);
    session.endedAt=new Date(timestamp).toISOString();
   }
  }
  db.mobileEventReceipts.push({id:e.id,userId:user.id,deviceId:credential.deviceId,hash:digest(JSON.stringify(e)),receivedAt:now});accepted.push(e.id);
 }
 db.locationPoints=db.locationPoints.filter(p=>Date.parse(p.recordedAt)>=cutoff);
 db.mobileEventReceipts=db.mobileEventReceipts.filter(r=>r.receivedAt>=cutoff);
 return {accepted};
}
function createHandler({readDb,mutateDb,body,json,validPassword}){
 const attempts=new Map();
 return async(req,res,url)=>{
  if(!url.pathname.startsWith('/api/mobile/'))return false;
  try{
   if(url.pathname==='/api/mobile/login'&&req.method==='POST'){
    const input=await body(req),key=req.socket.remoteAddress;
    const counter=attempts.get(key);if(counter&&counter.until>Date.now()&&counter.count>=20)fail('Demasiados intentos; espere 15 minutos',429);
    if(!counter||counter.until<Date.now())attempts.set(key,{count:0,until:Date.now()+900000});
    attempts.get(key).count++;
    if(attempts.size>10000)for(const [k,v]of attempts)if(v.until<Date.now())attempts.delete(k);
    if(!uuid(input.deviceId))fail('Dispositivo no válido');
    const token=crypto.randomBytes(32).toString('hex');
    const result=await mutateDb(db=>{
     const user=db.users.find(u=>u.username.toLowerCase()===String(input.username||'').trim().toLowerCase()&&u.active);
     if(!user||!validPassword(String(input.password||''),user))fail('Usuario o contraseña incorrectos',401);
     if(user.role!=='seller')fail('Esta aplicación es exclusiva para vendedores',403);
     db.mobileTokens=(db.mobileTokens||[]).filter(t=>Date.parse(t.expiresAt)>Date.now()&&!(t.userId===user.id&&t.deviceId===input.deviceId));
     db.mobileTokens.push({hash:digest(token),userId:user.id,deviceId:input.deviceId,passwordVersion:digest(user.passwordHash),expiresAt:new Date(Date.now()+90*86400000).toISOString()});
     return {token,user:{id:user.id,name:user.name,role:user.role}};
    });attempts.delete(key);json(res,200,result);return true;
   }
   const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
   if(!/^[a-f0-9]{64}$/.test(token))fail('Inicie sesión',401);
   if(url.pathname==='/api/mobile/sync'&&req.method==='POST'){
    const input=await body(req);const result=await mutateDb(db=>{const {user,credential}=authenticate(db,token);return syncEvents(db,user,credential,input);});json(res,200,result);
   }else if(url.pathname==='/api/mobile/status'&&req.method==='GET'){
    const db=readDb(),{user}=authenticate(db,token);json(res,200,{user:{id:user.id,name:user.name},session:db.trackingSessions.find(s=>s.userId===user.id&&!s.endedAt)||null});
   }else if(url.pathname==='/api/mobile/logout'&&req.method==='POST'){
    await mutateDb(db=>{authenticate(db,token);db.mobileTokens=db.mobileTokens.filter(t=>t.hash!==digest(token));});json(res,200,{ok:true});
   }else{json(res,404,{error:'Ruta no encontrada'});}
  }catch(error){json(res,error.status||500,{error:error.status?error.message:'No se pudo procesar la sincronización'});}
  return true;
 };
}
module.exports={createHandler,syncEvents,authenticate,digest};
