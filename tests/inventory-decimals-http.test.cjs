const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('inventory create, edit and reload retain decimals while invalid input does not overwrite data',async()=>{
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});
  const data=fs.mkdtempSync(path.resolve('tmp/inventory-decimals-'));
  process.env.AVANZA_DATA_DIR=data;process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.ADMIN_PASSWORD='InventoryTest123!';
  const {server}=require('../server');
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.ADMIN_PASSWORD})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const call=(url,method='GET',body)=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const long='0.123456789012345678901234567890123456789';
    const input={material:'BOND',calibre:'3,75125',ancho:'13.75678',peso:'12.498765',gramaje:long};
    const created=await call('/api/inventory/items','POST',input);assert.equal(created.status,201);
    let stored=(await (await call('/api/inventory')).json()).items[0];
    assert.equal(stored.calibre,3.75125);assert.equal(stored.ancho,13.75678);assert.equal(stored.peso,12.498765);assert.equal(stored.gramaje,long);
    const updated=await call('/api/inventory/items/'+stored.id,'PATCH',{...input,peso:'25,0012345'});assert.equal(updated.status,200);
    stored=(await (await call('/api/inventory')).json()).items[0];assert.equal(stored.peso,25.0012345);assert.equal(stored.gramaje,long);
    const disk=JSON.parse(fs.readFileSync(path.join(data,'database.json'),'utf8'));assert.equal(disk.inventoryItems[0].gramaje,long);assert.equal(disk.inventoryItems[0].peso,25.0012345);
    const invalid=await call('/api/inventory/items/'+stored.id,'PATCH',{...input,peso:'1.2.3'});assert.equal(invalid.status,400);
    assert.equal((await (await call('/api/inventory')).json()).items[0].peso,25.0012345);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
