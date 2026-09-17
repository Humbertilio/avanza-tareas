const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),X=require('xlsx'),crypto=require('crypto');
const {importInventory}=require('../inventory-import');
const source=fs.readFileSync(require.resolve('../server'),'utf8'),context={crypto,clean:(value,max)=>String(value??'').trim().slice(0,max)};vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function inventoryNumber('),source.indexOf('function productPrice(')),context);
const run=(db,book)=>importInventory(db,book,{fileName:'test.xlsx',fileHash:'hash',importedBy:'Prueba'},context.validatedInventoryItem,context.inventoryRowHash);
const book=sheets=>{const w=X.utils.book_new();for(const [name,rows]of Object.entries(sheets))X.utils.book_append_sheet(w,X.utils.aoa_to_sheet(rows),name);return w;};
const db=()=>({inventoryItems:[],inventoryImports:[]});
test('all sheets validated before writing; reports every bad field and exact row',()=>{const data=db(),w=book({Correcta:[['Material','Calibre','Ancho'],['Bond',4,20]],Errores:[['Material','Calibre','Ancho'],[],['Bond','no-numérico',-13.75]]});assert.throws(()=>run(data,w),e=>{assert.equal(e.status,422);assert.equal(e.errors.length,2);assert.ok(e.errors.every(x=>x.sheet==='Errores'&&x.row===3));assert.deepEqual(e.errors.map(x=>x.field),['calibre','ancho']);return true;});assert.equal(data.inventoryItems.length,0);assert.equal(data.inventoryImports.length,0);});
test('duplicates in file and inventory reject entire import',()=>{const data=db(),w=book({Uno:[['Material','ID'],['Bond','A1']],Dos:[['Material','ID'],['Bond','A1']]});assert.throws(()=>run(data,w),e=>e.errors.some(x=>x.cause.includes('Uno, fila 2')));assert.equal(data.inventoryItems.length,0);const valid=book({Uno:[['Material','ID'],['Bond','A1']]});assert.equal(run(data,valid).imported,1);assert.throws(()=>run(data,valid),e=>e.errors.some(x=>x.cause.includes('el inventario')));assert.equal(data.inventoryItems.length,1);assert.equal(data.inventoryImports.length,1);});
test('missing headers and Excel cell errors are reported; valid multiple sheets import together',()=>{const data=db();assert.throws(()=>run(data,book({Uno:[['Otro'],['Bond']]})),e=>e.errors.some(x=>x.cause.includes('encabezado')));const w=book({Uno:[['Material','Peso'],['Bond',1]]});w.Sheets.Uno.B2={t:'e',v:7,w:'#DIV/0!'};assert.throws(()=>run(data,w),e=>e.errors.some(x=>x.cause.includes('error de Excel')));assert.equal(data.inventoryItems.length,0);assert.equal(run(data,book({Uno:[['Material','ID'],['Bond','A1']],Dos:[['Material','ID'],['Bond','A2']]})).imported,2);assert.equal(data.inventoryImports.length,2);});

test('preserves decimal numbers and trims only text before validation',()=>{
 const data=db();run(data,book({Uno:[['Material','Calibre','Ancho','Peso','Gramaje','Ubicación','ID','Observación','Destino'],[' Bond extra ',3.75,13.75,12.49,80.5,' ABC123456 ',' 123456789 ', 'x'.repeat(45),'y'.repeat(44)]]}));
 const item=data.inventoryItems[0];assert.equal(item.material,'BOND');assert.equal(item.calibre,3.75);assert.equal(item.ancho,13.75);assert.equal(item.peso,12.49);assert.equal(item.gramaje,80.5);assert.equal(item.ubicacion,'ABC123');assert.equal(item.externalId,'1234567');assert.equal(item.observacion.length,40);assert.equal(item.destino.length,40);
 const more=db();run(more,book({Uno:[['Material','Ancho','Peso'],['Bond',1.15,'3,75']]}));assert.equal(more.inventoryItems[0].ancho,1.15);assert.equal(more.inventoryItems[0].peso,3.75);
});
test('collisions produced by text truncation still block all rows',()=>{
 for(const rows of [[['Material','ID'],['Bond','12345678'],['Bond','12345679']]]){const data=db();assert.throws(()=>run(data,book({Uno:rows})),e=>e.errors.some(x=>x.cause.includes('duplicado')));assert.equal(data.inventoryItems.length,0);assert.equal(data.inventoryImports.length,0);}
});

test('decimal values are distinct, and equivalent decimal spellings still deduplicate',()=>{
 const data=db();assert.equal(run(data,book({Uno:[['Material','Calibre'],['Bond',3.75],['Bond',4.2]]})).imported,2);
 assert.throws(()=>run(db(),book({Uno:[['Material','Calibre'],['Bond','3,7500'],['Bond',3.75]]})),e=>e.errors.some(x=>x.cause.includes('duplicado')));
});
test('all numeric inventory fields accept decimal point or comma and retain long precision',()=>{
 for(const field of ['calibre','ancho','peso','gramaje']){
  for(const [input,expected] of [['12.3456789',12.3456789],['12,3456789',12.3456789],['0,001',0.001],['.25',0.25],['1,234.56789',1234.56789],['1,234,567',1234567],[0.00000001,0.00000001],['1.12345678901234567890123456789','1.12345678901234567890123456789'],['9007199254740993','9007199254740993'],['',null],[0,0]]){
   assert.equal(context.validatedInventoryItem({material:'BOND',[field]:input})[field],expected);
  }
  for(const input of ['-1.2','abc','1.2.3','1,2,3',Infinity,NaN,true,'1e5'])assert.throws(()=>context.validatedInventoryItem({material:'BOND',[field]:input}),e=>e.status===400);
 }
 const long='0.12345678901234567890123456789',data=db();
 run(data,book({Uno:[['Material','Calibre','Ancho','Peso','Gramaje'],['BOND',long,long,long,long]]}));
 for(const field of ['calibre','ancho','peso','gramaje'])assert.equal(data.inventoryItems[0][field],long);
});
