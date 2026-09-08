const {test}=require('node:test');
const assert=require('node:assert/strict');
const XLSX=require('xlsx');
const {createOrder,buildWorkbook,updateOrder}=require('../product-orders');
const employee={id:'employee',role:'employee',name:'Enlace'};
function fixture(){
  const user={id:'client',name:'Ana Pérez',phone:'70012345',companyId:'company',role:'client',active:true};
  const db={users:[user],products:[{id:'p1',product:'Producto uno',price3:12.5},{id:'p2',product:'Producto dos',price3:3}],conversations:[{id:'group',companyId:'company',type:'group',settings:{clientGroup:true}},{id:'other',companyId:'other-company',type:'group',settings:{clientGroup:true}}],conversationParticipants:[{conversationId:'group',userId:'client'},{conversationId:'group',userId:'employee'},{conversationId:'other',userId:'someone'}],messages:[],attachments:[],messageReceipts:[]};
  const input={requestId:'test-request-123456',items:[{productId:'p1',quantity:2,price3:12.5}]};
  return {user,db,input};
}
test('inline order, legacy workbook, identity, assigned chat and duplicate protection',()=>{
  const {user,db,input}=fixture();
  const result=createOrder(db,user,input);
  assert.equal(result.order.conversationId,'group');
  assert.equal(db.messages.length,1);assert.equal(db.attachments.length,0);
  assert.deepEqual(db.messageReceipts.map(r=>r.userId),['client','employee']);
  const book=XLSX.read(buildWorkbook(db.productOrders[0]),{type:'buffer'}),sheet=book.Sheets.Pedido;
  assert.equal(sheet.A1.v,'Cliente: Ana Pérez | Teléfono: 70012345');
  assert.equal(sheet.A7.v,'Producto uno');assert.equal(sheet.B7.v,2);assert.equal(sheet.C7.v,12.5);
  assert.equal(sheet.D7.f,'IF(ISNUMBER(C7),ROUND(B7*C7,2),"Por confirmar")');assert.equal(sheet.D7.v,25);
  assert.equal(sheet.D8.f,'SUM(D7:D7)');assert.equal(sheet.D8.v,25);
  assert.equal(createOrder(db,user,input).duplicate,true);assert.equal(db.messages.length,1);
});
test('rejects invalid quantities, unavailable products, changed prices and unassigned clients',()=>{
  for(const quantity of [0,-1,NaN,Infinity,1000001,0.0001,'2']){
    const {db,user,input}=fixture();input.items[0].quantity=quantity;
    assert.throws(()=>createOrder(db,user,input));assert.equal(db.messages.length,0);
  }
  for(const modify of [f=>f.input.items=[],f=>f.input.items.push(f.input.items[0]),f=>f.db.products=[],f=>f.db.products[0].price3=null,f=>f.db.products[0].price3=99,f=>f.user.companyId='unassigned',f=>f.user.role='employee']){
    const f=fixture();modify(f);assert.throws(()=>createOrder(f.db,f.user,f.input));assert.equal(f.db.messages.length,0);
  }
});
test('product names remain literal text in Excel',()=>{
  const {db,user,input}=fixture();db.products[0].product='=HYPERLINK("example")';
  createOrder(db,user,input);const sheet=XLSX.read(buildWorkbook(db.productOrders[0])).Sheets.Pedido;
  assert.equal(sheet.A7.t,'s');assert.equal(sheet.A7.f,undefined);
});

test('quote, requested changes, approval, immutable history and approved prices',()=>{
 const {db,user,input}=fixture(),{order}=createOrder(db,user,input);
 const act=(actor,action,extra={})=>updateOrder(db,actor,order.id,{action,actionId:require('crypto').randomUUID(),revision:order.revision,items:order.items.map(i=>({...i})),note:'Entrega mañana',...extra});
 assert.equal(order.status,'sent');assert.equal(db.messages[0].orderId,order.id);
 assert.throws(()=>act(user,'approve'),/pendiente/);
 act(employee,'saveQuote',{items:[{...order.items[0],price3:null}]});
 assert.throws(()=>act(employee,'sendQuote'),/Complete todos/);
 act(employee,'sendQuote',{items:[{...order.items[0],price3:20}]});assert.equal(order.items[0].amount,40);
 assert.throws(()=>act(employee,'saveQuote'),/Espere/);
 assert.throws(()=>act(user,'requestChanges',{items:[{...order.items[0],price3:1}]}),/precios/);
 act(user,'requestChanges',{items:[{...order.items[0],quantity:3}]});assert.equal(order.status,'changes_requested');
 act(employee,'sendQuote');act(user,'approve');
 assert.equal(order.status,'approved');assert.equal(order.items[0].amount,60);assert.equal(order.approvedBy,user.id);
 assert.equal(order.history[0].items[0].price3,12.5);assert.equal(order.history[2].items[0].quantity,2);assert.equal(order.history.length,6);
 assert.throws(()=>act(employee,'saveQuote'),/aprobado/);assert.throws(()=>act(user,'requestChanges'),/aprobado/);
 assert.equal(db.attachments.length,0);
});
test('only links quote, only creator approves, stale edits and retries are safe',()=>{
 const {db,user,input}=fixture(),{order}=createOrder(db,user,input),data={action:'sendQuote',actionId:'action-1234567890',revision:1,items:order.items,note:''};
 for(const actor of [user,{id:'outsider',role:'employee'},{id:'observer',role:'admin'}])assert.throws(()=>updateOrder(db,actor,order.id,data),e=>e.status===403);
 updateOrder(db,employee,order.id,data);const count=db.messages.length;
 assert.equal(updateOrder(db,employee,order.id,data).duplicate,true);assert.equal(db.messages.length,count);
 assert.throws(()=>updateOrder(db,user,order.id,{...data,action:'approve',actionId:'approve-123456789',revision:1}),e=>e.status===409);
 db.conversationParticipants.push({conversationId:'group',userId:'client2'});
 assert.throws(()=>updateOrder(db,{id:'client2',role:'client'},order.id,{...data,action:'approve',revision:2}),e=>e.status===403);
});
test('unpriced products keep quantities and pending price in order and editable workbook',()=>{
 const {db,user,input}=fixture();db.products[0].price3=null;input.items[0].price3=null;
 input.items.push({productId:'p2',quantity:2,price3:3});
 const {order}=createOrder(db,user,input);assert.equal(order.items[0].quantity,2);assert.equal(order.items[0].price3,null);assert.equal(order.items[0].amount,null);
 const sheet=XLSX.read(buildWorkbook(db.productOrders[0])).Sheets.Pedido;
 assert.equal(sheet.C7.v,'Por confirmar');assert.equal(sheet.D7.v,'Por confirmar');assert.match(sheet.D7.f,/ISNUMBER/);assert.equal(sheet.D9.v,6);assert.equal(sheet.A9.v,'SUBTOTAL CON PRECIO');
});
