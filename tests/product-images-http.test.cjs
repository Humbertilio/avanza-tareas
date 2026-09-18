const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('admin manages product photos and clients can view them',async()=>{
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});
  const data=fs.mkdtempSync(path.resolve('tmp/product-images-'));
  process.env.AVANZA_DATA_DIR=data;process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.ADMIN_PASSWORD='ImageTest123!';
  const {server}=require('../server');
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const file=path.join(data,'database.json'),db=JSON.parse(fs.readFileSync(file,'utf8'));
    db.users.push({...db.users[0],id:'client',username:'client.images',name:'Cliente',role:'client'});
    fs.writeFileSync(file,JSON.stringify(db));
    const login=async username=>{const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'ImageTest123!'})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    const admin=await login('admin'),client=await login('client.images');
    let response=await fetch(base+'/api/products',{method:'POST',headers:{Cookie:admin,'Content-Type':'application/json'},body:JSON.stringify({div:'IMP',product:'Producto fotográfico',price1:1,price2:2,price3:3})});
    assert.equal(response.status,201);const product=(await response.json()).product;
    const image={name:'foto.jpg',mimeType:'image/jpeg',data:'data:image/jpeg;base64,'+Buffer.from('photo').toString('base64')};
    response=await fetch(`${base}/api/products/${product.id}/images`,{method:'POST',headers:{Cookie:admin,'Content-Type':'application/json'},body:JSON.stringify({images:[image,{...image,name:'foto-2.jpg'}]})});
    assert.equal(response.status,201);const uploaded=(await response.json()).images;assert.equal(uploaded.length,2);
    response=await fetch(base+'/api/products',{headers:{Cookie:client}});const visible=(await response.json()).products.find(item=>item.id===product.id);assert.equal(visible.images.length,2);assert.ok(!('data' in visible.images[0]));
    response=await fetch(base+visible.images[0].url,{headers:{Cookie:client}});assert.equal(response.status,200);assert.equal(await response.text(),'photo');
    response=await fetch(`${base}/api/products/${product.id}/images`,{method:'POST',headers:{Cookie:client,'Content-Type':'application/json'},body:JSON.stringify({images:[image]})});assert.equal(response.status,403);
    response=await fetch(`${base}/api/products/${product.id}/images/${uploaded[0].id}`,{method:'DELETE',headers:{Cookie:admin}});assert.equal(response.status,200);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
