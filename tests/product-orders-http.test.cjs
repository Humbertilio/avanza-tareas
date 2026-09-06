const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('client sends and downloads order through authenticated HTTP; unrelated client cannot download',async()=>{
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});
  const data=fs.mkdtempSync(path.resolve('tmp/orders-http-'));
  process.env.AVANZA_DATA_DIR=data;process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.ADMIN_PASSWORD='OrderTest123!';
  const {server}=require('../server');
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const file=path.join(data,'database.json'),db=JSON.parse(fs.readFileSync(file,'utf8'));
    db.users.push({...db.users[0],id:'buyer',username:'buyer',role:'client',companyId:'company',name:'Cliente HTTP',phone:'70012345'},{...db.users[0],id:'outsider',username:'outsider',role:'client',companyId:'other'});
    db.conversations.push({id:'group',type:'group',companyId:'company',settings:{clientGroup:true},createdAt:new Date().toISOString()});
    db.conversationParticipants.push({id:'p',conversationId:'group',userId:'buyer'});
    db.products=[{id:'product',div:'1',product:'Artículo',price3:15}];
    fs.writeFileSync(file,JSON.stringify(db));
    async function login(username){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'OrderTest123!'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
    const cookie=await login('buyer');
    const send=()=>fetch(base+'/api/products/orders',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({requestId:'http-order-12345678',items:[{productId:'product',quantity:3,price3:15}]})});
    let r=await send();assert.equal(r.status,201);const order=(await r.json()).order;assert.equal(order.clientPhone,'70012345');
    r=await send();assert.equal(r.status,200);
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.messages.length,1);
    const url=base+'/api/chat/attachments/'+saved.attachments[0].id;
    r=await fetch(url,{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/\.xlsx/);assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,2).toString(),'PK');
    r=await fetch(url,{headers:{Cookie:await login('outsider')}});assert.equal(r.status,403);
  }finally{await new Promise(r=>server.close(r));}
});
