const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
test('inventory selection reaches its client chat, retries safely, quotes and approves without changing stock',async()=>{
 const data=fs.mkdtempSync(path.resolve('tmp/inventory-chat-'));
 Object.assign(process.env,{AVANZA_DATA_DIR:data,PORT:'0',HOST:'127.0.0.1',ADMIN_PASSWORD:'InventoryTest123!'});
 const {server}=require('../server');
 if(!server.listening)await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const file=path.join(data,'database.json'),db=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const [id,role,companyId] of [['buyer','client','company'],['other','client','other'],['seller','seller',null]])db.users.push({...db.users[0],id,username:id,name:id,role,companyId});
  db.conversations.push({id:'group',type:'group',companyId:'company',settings:{clientGroup:true},createdAt:new Date().toISOString()});
  for(const userId of ['buyer','seller'])db.conversationParticipants.push({id:randomUUID(),conversationId:'group',userId});
  db.inventoryItems=[{id:'stock1',material:'Acero',externalId:'A001',peso:'12.1234567890123456789',calibre:0.56789,active:true,ubicacion:'private-location',destino:'private-destination'},{id:'inactive',active:false}];
  db.purchaseRequests=[{id:'legacy',customerId:'buyer',itemIds:['stock1'],status:'pending',createdAt:new Date().toISOString()}];
  fs.writeFileSync(file,JSON.stringify(db));
  async function login(username){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'InventoryTest123!'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  const buyer=await login('buyer'),seller=await login('seller'),other=await login('other');
  const api=async(cookie,url,method='GET',body)=>{const r=await fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,...await r.json()};};
  const payload={requestId:randomUUID(),itemIds:['stock1'],comments:'Entrega en la mañana'};
  for(const itemIds of [[],['inactive'],['missing'],['stock1','stock1']])assert.ok((await api(buyer,'/api/inventory/orders','POST',{...payload,itemIds})).status>=400);
  assert.equal((await api(seller,'/api/inventory/orders','POST',payload)).status,403);
  assert.equal((await api(other,'/api/inventory/orders','POST',payload)).status,409);
  const result=await api(buyer,'/api/inventory/orders','POST',payload);assert.equal(result.status,201);
  const order=result.order;assert.equal(order.source,'inventory');assert.equal(order.conversationId,'group');assert.equal(order.note,payload.comments);
  assert.equal(order.items[0].quantity,1);assert.equal(order.items[0].price3,null);
  assert.match(order.items[0].product,/12.1234567890123456789/);assert.ok(!JSON.stringify(order).includes('private-'));
  assert.equal((await api(buyer,'/api/inventory/orders','POST',payload)).status,200);
  assert.equal((await api(buyer,'/api/products/orders','POST',{requestId:payload.requestId,items:[]})).status,409);
  const chat=await api(buyer,'/api/chat/conversations/group/messages');assert.equal(chat.messages.length,1);assert.equal(chat.messages[0].order.id,order.id);
  const url='/api/products/orders/'+order.id;
  assert.equal((await api(other,url)).status,403);
  const quote={action:'sendQuote',actionId:randomUUID(),revision:1,note:'Cotizado',items:order.items.map(i=>({...i,price3:25}))};
  assert.equal((await api(buyer,url,'PATCH',quote)).status,403);
  assert.equal((await api(seller,url,'PATCH',quote)).status,200);
  const approved=await api(buyer,url,'PATCH',{action:'approve',actionId:randomUUID(),revision:2});assert.equal(approved.status,200);assert.equal(approved.order.status,'approved');
  const list=await api(buyer,'/api/inventory');assert.equal(list.orders.length,2);assert.equal(list.orders.find(o=>o.id===order.id).status,'approved');assert.equal(list.orders.find(o=>o.id==='legacy').status,'pending');
  assert.equal((await api(other,'/api/inventory')).orders.length,0);
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(saved.inventoryItems,db.inventoryItems);assert.deepEqual(saved.purchaseRequests,db.purchaseRequests);assert.equal(saved.productOrders.length,1);assert.equal(saved.productOrders[0].history.length,3);
 }finally{await new Promise(r=>server.close(r));}
});
