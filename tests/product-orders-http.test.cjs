const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('client sends inline order through HTTP; unrelated client cannot read',async()=>{
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
    for(const id of ['enlace','enlace2']){db.users.push({...db.users[0],id,username:id,role:id==='enlace2'?'seller':'employee'});db.conversationParticipants.push({id,conversationId:'group',userId:id});}
    fs.writeFileSync(file,JSON.stringify(db));
    async function login(username){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'OrderTest123!'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
    const cookie=await login('buyer');
    const send=()=>fetch(base+'/api/products/orders',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({requestId:'http-order-12345678',items:[{productId:'product',quantity:3,price3:15}]})});
    let r=await send();assert.equal(r.status,201);const order=(await r.json()).order;assert.equal(order.clientPhone,'70012345');
    r=await send();assert.equal(r.status,200);
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.messages.length,1);
    assert.equal(saved.attachments.length,0);
    const url=base+'/api/products/orders/'+order.id;
    r=await fetch(url,{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.equal((await r.json()).order.status,'sent');
    r=await fetch(url,{headers:{Cookie:await login('outsider')}});assert.equal(r.status,403);
    r=await fetch(base+'/api/chat/conversations/group/messages',{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.equal((await r.json()).messages[0].order.id,order.id);
    const patch=async(cookie,payload)=>{const response=await fetch(url,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)});return {status:response.status,...await response.json()};};
    const links=await Promise.all(['enlace','enlace2'].map(login));
    const payload={action:'sendQuote',actionId:'quote-http-12345678',revision:1,items:[{productId:'product',quantity:3,price3:20}],note:'Entrega incluida'};
    assert.equal((await patch(cookie,payload)).status,403);
    const edits=await Promise.all(links.map(c=>patch(c,payload)));assert.deepEqual(edits.map(e=>e.status).sort(),[200,409]);
    const winner=links[edits.findIndex(e=>e.status===200)];assert.equal((await patch(winner,payload)).status,200);
    assert.equal((await patch(cookie,{action:'approve',actionId:'approve-http-123456',revision:1})).status,409);
    const approved=await patch(cookie,{action:'approve',actionId:'approve-http-123456',revision:2});assert.equal(approved.status,200);assert.equal(approved.order.status,'approved');assert.equal(approved.order.items[0].amount,60);
    assert.equal((await patch(winner,{...payload,actionId:'after-http-12345678',revision:3})).status,409);
    const final=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(final.productOrders[0].history.length,3);assert.equal(final.messages.length,3);
    r=await fetch(base+'/api/chat/members',{headers:{Cookie:cookie}});assert.equal(r.status,200);
    const contacts=(await r.json()).members;assert.ok(contacts.some(m=>m.id==='enlace2'));assert.ok(contacts.some(m=>m.role==='admin'));assert.ok(!contacts.some(m=>m.id==='enlace'||m.id==='outsider'));
    const direct=async userId=>fetch(base+'/api/chat/conversations',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({userId})});
    assert.equal((await direct('enlace')).status,403);assert.equal((await direct('outsider')).status,403);
    r=await direct('enlace2');assert.equal(r.status,201);const conversation=(await r.json()).conversation;
    r=await direct('enlace2');assert.equal((await r.json()).conversation.id,conversation.id);
    r=await direct(contacts.find(m=>m.role==='admin').id);assert.equal(r.status,201);
    r=await fetch(base+'/api/chat/conversations',{headers:{Cookie:cookie}});assert.ok((await r.json()).conversations.some(c=>c.id===conversation.id));
    const messageUrl=base+'/api/chat/conversations/'+conversation.id+'/messages';
    for(const who of [cookie,links[1]]){r=await fetch(messageUrl,{method:'POST',headers:{Cookie:who,'Content-Type':'application/json'},body:JSON.stringify({text:'Mensaje privado de prueba'})});assert.equal(r.status,201);}
    r=await fetch(messageUrl,{headers:{Cookie:cookie}});assert.equal((await r.json()).messages.length,2);
    r=await fetch(messageUrl,{headers:{Cookie:await login('outsider')}});assert.equal(r.status,403);

    for(const asset of ['/chat-orders.js','/chat-orders.css','/service-worker.js'])assert.equal((await fetch(base+asset)).status,200);
  }finally{await new Promise(r=>server.close(r));}
});
