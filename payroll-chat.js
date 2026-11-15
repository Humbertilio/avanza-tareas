'use strict';
const crypto=require('node:crypto');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const PERIOD={from:'2026-11-06',to:'2026-11-19',startsAt:'2026-11-06 05:00:00',endsAt:'2026-11-19 23:59:59',timeZone:'America/Santo_Domingo'};
function upsert(db,report,input,digest){
 const p=db.payrollPunches;
 if(report.from!==PERIOD.from||report.to!==PERIOD.to||report.rows.length!==14)fail(400,'La bisemana configurada es del 6 al 19 de noviembre de 2026');
 if(!Number.isSafeInteger(input.revision)||input.revision<1)fail(400,'Revisión inválida');
 for(const row of report.rows)for(const punch of row.punches)if(punch&&(punch<PERIOD.startsAt||punch>PERIOD.endsAt))fail(400,'Punch fuera de los límites de la bisemana');
 const employee=p.employees.find(e=>e.id===report.employeeId&&e.active&&e.ready),link=p.links.find(l=>l.employeeId===report.employeeId);
 const user=link&&db.users.find(u=>u.id===link.userId&&u.active&&u.role==='payroll_employee');
 if(!employee||!user)fail(409,'Empleado sin vínculo activo y confirmado');
 const now=new Date().toISOString(),key=report.employeeId+'|'+report.from+'|'+report.to;
 let message=db.messages.find(m=>m.payrollTable?.key===key);
 if(message){
  if(message.payrollTable.userId!==user.id)fail(409,'El destinatario de la tabla no puede cambiar');
  if(input.revision<message.payrollTable.revision)fail(409,'Revisión anterior a la recibida');
  if(input.revision===message.payrollTable.revision){if(message.payrollTable.digest!==digest)fail(409,'La revisión ya tiene otro contenido');return{id:message.id,conversationId:message.conversationId,duplicate:true};}
  if(message.payrollTable.digest===digest){message.payrollTable.revision=input.revision;return{id:message.id,conversationId:message.conversationId,duplicate:true};}
 }
 let conversation=message&&db.conversations.find(c=>c.id===message.conversationId);
 if(!conversation)conversation=db.conversations.find(c=>c.settings?.payrollEmployeeId===employee.id&&c.settings?.payrollUserId===user.id);
 if(!conversation){
  const admin=db.users.find(u=>u.id===p.senderAdminId&&u.active&&u.role==='admin')||db.users.find(u=>u.active&&u.role==='admin');
  if(!admin)fail(409,'No existe administrador para el chat de Nómina');
  conversation={id:crypto.randomUUID(),type:'direct',title:'Nómina · '+employee.name,createdBy:admin.id,createdAt:now,updatedAt:now,pinnedBy:[],settings:{payrollEmployeeId:employee.id,payrollUserId:user.id}};
  db.conversations.push(conversation);
  for(const id of [admin.id,user.id])db.conversationParticipants.push({id:crypto.randomUUID(),conversationId:conversation.id,userId:id,role:'member',joinedAt:now,lastReadAt:null,lastReadMessageId:null,muted:false});
 }
 const created=!message;
 if(!message){message={id:crypto.randomUUID(),conversationId:conversation.id,senderId:conversation.createdBy,type:'payroll-table',text:'Punches · 6 al 19 de noviembre de 2026',createdAt:now,updatedAt:now,deletedAt:null};db.messages.push(message);}
 message.payrollTable={key,userId:user.id,employeeId:employee.id,employeeName:employee.name,employeeCode:employee.code,...PERIOD,rows:report.rows,revision:input.revision,digest,updatedAt:now};
 message.updatedAt=now;conversation.updatedAt=now;
 for(const participant of db.conversationParticipants.filter(x=>x.conversationId===conversation.id)){
  let receipt=db.messageReceipts.find(r=>r.messageId===message.id&&r.userId===participant.userId);
  if(!receipt){receipt={id:crypto.randomUUID(),messageId:message.id,userId:participant.userId};db.messageReceipts.push(receipt);}
  receipt.readAt=participant.userId===message.senderId?now:null;receipt.deliveredAt=participant.userId===message.senderId?now:null;
 }
 p.audit.push({at:now,actor:'nomina',action:created?'chat-table-created':'chat-table-updated',messageId:message.id,employeeId:employee.id,revision:input.revision});
 return{id:message.id,conversationId:conversation.id,duplicate:false,created};
}
function owns(db,user,id){return db.conversations.some(c=>c.id===id&&c.settings?.payrollUserId===user.id)&&db.conversationParticipants.some(p=>p.conversationId===id&&p.userId===user.id);}
function allowed(db,user,req,url){
 if(req.method==='GET'&&['/api/me','/api/chat/events','/api/chat/conversations','/api/chat/members'].includes(url.pathname))return true;
 const match=url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/(messages|read|typing)$/);
 if(match&&((match[2]==='messages'&&['GET','POST'].includes(req.method))||(['read','typing'].includes(match[2])&&req.method==='POST')))return owns(db,user,match[1]);
 const attachment=url.pathname.match(/^\/api\/chat\/attachments\/([^/]+)$/);
 return !!(attachment&&req.method==='GET'&&db.attachments.some(a=>a.id===attachment[1]&&owns(db,user,a.conversationId)));
}
module.exports={PERIOD,upsert,owns,allowed};
