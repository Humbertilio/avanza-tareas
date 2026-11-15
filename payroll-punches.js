'use strict';
const crypto = require('node:crypto');
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const text = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail(400, 'Fecha inválida');
  return value;
}
function validateReport(input) {
  const from = date(input.from), to = date(input.to), count = (Date.parse(to)-Date.parse(from))/86400000+1;
  if (count < 1 || count > 366 || !Array.isArray(input.rows) || input.rows.length !== count) fail(400, 'El reporte debe incluir cada día del rango, hasta 366 días');
  const rows = input.rows.map((row, i) => {
    const expected = new Date(Date.parse(from)+i*86400000).toISOString().slice(0,10);
    if (row.date !== expected || !Array.isArray(row.punches) || row.punches.length !== 4) fail(400, 'Días o marcaciones inválidos');
    const punches = row.punches.map(p => {
      if (p === null) return null;
      if (typeof p !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(p)) fail(400, 'Marcación inválida');
      date(p.slice(0,10));
      if (+p.slice(11,13)>23 || +p.slice(14,16)>59 || +p.slice(17,19)>59) fail(400,'Hora inválida');
      return p.replace('T',' ');
    });
    return {date: expected, punches};
  });
  const employeeId = text(input.employeeId,100);
  if (!employeeId) fail(400,'Falta el empleado');
  return {employeeId, from, to, rows};
}
function state(db) { return db.payrollPunches ||= {employees:[],links:[],reports:[],audit:[]}; }
function audit(p, actor, action, detail) { p.audit.push({at:new Date().toISOString(),actor,action,...detail}); }
function activeLink(db,p,id) {
  const employee = p.employees.find(e=>e.id===id && e.active);
  const link = p.links.find(l=>l.employeeId===id);
  const user = link && db.users.find(u=>u.id===link.userId && u.active && u.role==='payroll_employee');
  return employee && user ? {employee,link,user} : null;
}
function createHandler({readDb,mutateDb,body,json,currentUser,passwordHash,emitConversation}) {
  return async function(req,res,url) {
    if (!url.pathname.startsWith('/api/payroll/')) return false;
    try {
      const route=url.pathname.slice('/api/payroll/'.length), integration=route.startsWith('integration/');
      let actor;
      if (integration) {
        const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
        const saved=readDb().payrollPunches?.tokenHash;
        if (!saved || !crypto.timingSafeEqual(Buffer.from(hash(token),'hex'),Buffer.from(saved,'hex'))) fail(401,'Conexión de Nómina no autorizada');
        actor='nomina';
      } else {
        actor=currentUser(req);
        if (!actor) fail(401,'Inicie sesión');
        if (!['admin','payroll_employee'].includes(actor.role)) fail(403,'Sin acceso a Nómina');
        if (!['GET','HEAD'].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403,'Origen no autorizado');
      }
      const admin=()=>{if(actor.role!=='admin')fail(403,'Solo el administrador');};
      if(route==='connection' && req.method==='POST') {
        admin(); const token=crypto.randomBytes(32).toString('hex');
        await mutateDb(db=>{const p=state(db);p.tokenHash=hash(token);p.senderAdminId=actor.id;audit(p,actor.id,'connection-renewed',{});});
        json(res,201,{token}); return true;
      }
      if(route==='integration/catalog' && req.method==='POST') {
        const input=await body(req);
        if(!Array.isArray(input.employees)||input.employees.length>10000)fail(400,'Catálogo inválido');
        const ids=new Set();
        const employees=input.employees.map(e=>{const id=text(e.id,100),name=text(e.name),code=text(e.code,60);if(!id||!name||!code||ids.has(id))fail(400,'Empleado inválido o duplicado');ids.add(id);return{id,name,code,department:text(e.department),clockId:text(e.clockId,100),active:e.active===true,ready:e.ready===true};});
        await mutateDb(db=>{const p=state(db);p.employees=employees;p.syncedAt=new Date().toISOString();audit(p,actor,'catalog',{count:employees.length});});
        json(res,200,{count:employees.length});return true;
      }
      if(route==='integration/links' && req.method==='GET') {
        const db=readDb(),p=state(db);
        json(res,200,{links:p.employees.map(e=>{const a=activeLink(db,p,e.id);return {employeeId:e.id,userId:a?.user.id||null,username:a?.user.username||null,ready:!!a&&e.ready};})});return true;
      }
      if(route==='integration/chat-table' && req.method==='POST') {
        const input=await body(req),report=validateReport(input),digest=hash(JSON.stringify(report));
        const result=await mutateDb(db=>require('./payroll-chat').upsert(db,report,input,digest));
        if(!result.duplicate){const db=readDb();emitConversation(db,result.conversationId,'conversation',{conversationId:result.conversationId});emitConversation(db,result.conversationId,'message-change',{conversationId:result.conversationId,messageId:result.id});}
        json(res,result.created?201:200,result);return true;
      }
      if(route==='integration/reports' && req.method==='POST') {
        const report=validateReport(await body(req)),digest=hash(JSON.stringify(report));
        const result=await mutateDb(db=>{
          const p=state(db),a=activeLink(db,p,report.employeeId);
          if(!a||!a.employee.ready)fail(409,'El empleado no tiene un vínculo activo y confirmado');
          const previous=p.reports.find(r=>r.digest===digest);
          if(previous)return {id:previous.id,duplicate:true};
          const saved={id:crypto.randomUUID(),...report,digest,userId:a.user.id,employeeName:a.employee.name,employeeCode:a.employee.code,receivedAt:new Date().toISOString(),readAt:null};
          p.reports.push(saved);audit(p,actor,'report-received',{id:saved.id,employeeId:report.employeeId,userId:a.user.id});
          return {id:saved.id,duplicate:false};
        });json(res,result.duplicate?200:201,result);return true;
      }
      if(route==='admin' && req.method==='GET') {
        admin();const db=readDb(),p=state(db);
        json(res,200,{tables:db.messages.filter(m=>m.payrollTable).map(m=>({id:m.id,conversationId:m.conversationId,employeeName:m.payrollTable.employeeName,from:m.payrollTable.from,to:m.payrollTable.to,updatedAt:m.updatedAt,readAt:db.messageReceipts.find(r=>r.messageId===m.id&&r.userId===m.payrollTable.userId)?.readAt||null})),connected:!!p.tokenHash,syncedAt:p.syncedAt||null,employees:p.employees,links:p.links,users:db.users.filter(u=>u.role==='payroll_employee').map(u=>({id:u.id,name:u.name,username:u.username,active:u.active})),reports:p.reports.slice(-100).reverse().map(({rows,digest,...r})=>r)});return true;
      }
      if(route==='links' && req.method==='POST') {
        admin();const input=await body(req),employeeId=text(input.employeeId,100),userId=text(input.userId,100);
        await mutateDb(db=>{const p=state(db),e=p.employees.find(e=>e.id===employeeId&&e.active&&e.ready),u=db.users.find(u=>u.id===userId&&u.active&&u.role==='payroll_employee');
          if(!e||!u)fail(400,'Seleccione empleado vinculado al reloj y usuario Emp Nomina activo');
          if(p.links.some(l=>(l.employeeId===employeeId&&l.userId!==userId)||(l.userId===userId&&l.employeeId!==employeeId)))fail(409,'Ya existe un vínculo. No se reasignan identidades con esta operación');
          if(!p.links.some(l=>l.employeeId===employeeId)){p.links.push({employeeId,userId,at:new Date().toISOString(),by:actor.id});audit(p,actor.id,'linked',{employeeId,userId});}
        });json(res,200,{ok:true});return true;
      }
      if(route==='accounts' && req.method==='POST') {
        admin();const input=await body(req),employeeId=text(input.employeeId,100),username=text(input.username,60).toLowerCase(),password=String(input.password||'');
        if(!/^[a-z0-9._-]{3,60}$/.test(username)||password.length!==4)fail(400,'Usuario válido y clave de 4 caracteres obligatorios');
        const result=await mutateDb(db=>{const p=state(db),e=p.employees.find(e=>e.id===employeeId&&e.active&&e.ready);
          if(!e||p.links.some(l=>l.employeeId===employeeId))fail(409,'Empleado inexistente, pendiente o ya vinculado');
          if(db.users.some(u=>u.username.toLowerCase()===username))fail(409,'El usuario ya existe; selecciónelo para vincularlo');
          const credentials=passwordHash(password),id=crypto.randomUUID();db.users.push({id,name:e.name,username,role:'payroll_employee',active:true,salt:credentials.salt,passwordHash:credentials.hash,createdAt:new Date().toISOString()});
          p.links.push({employeeId,userId:id,at:new Date().toISOString(),by:actor.id});audit(p,actor.id,'account-linked',{employeeId,userId:id});return{id,username};
        });json(res,201,result);return true;
      }
      if(route==='inbox' && req.method==='GET') {
        const p=state(readDb()),rows=p.reports.filter(r=>r.userId===actor.id);
        json(res,200,{reports:rows.slice().reverse().map(({rows,digest,...r})=>r)});return true;
      }
      const match=route.match(/^reports\/([a-f0-9-]+)(\/read)?$/);
      if(match && (req.method==='GET'&&!match[2]||req.method==='POST'&&match[2])) {
        const accessible=db=>{const r=state(db).reports.find(r=>r.id===match[1]);if(!r||(actor.role!=='admin'&&r.userId!==actor.id))fail(404,'Reporte no encontrado');return r;};
        if(req.method==='POST'){await mutateDb(db=>{const r=accessible(db);if(r.userId!==actor.id)fail(403,'Solo el destinatario confirma lectura');r.readAt ||= new Date().toISOString();});json(res,200,{ok:true});}
        else {const {digest,...report}=accessible(readDb());json(res,200,{report});}return true;
      }
      fail(404,'Operación no encontrada');
    }catch(error){json(res,error.status||500,{error:error.status?error.message:'No se pudo procesar Nómina'});return true;}
  };
}
module.exports={createHandler,validateReport};
