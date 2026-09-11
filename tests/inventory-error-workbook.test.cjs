const {test}=require('node:test'),assert=require('node:assert/strict'),X=require('xlsx'),Excel=require('exceljs');
const {errorWorkbook}=require('../inventory-error-workbook');
test('error copy preserves cells and marks only affected fields with red fill and notes',async()=>{
 const book=new Excel.Workbook(),sheet=book.addWorksheet('Datos');sheet.addRows([['Material','Calibre','Ancho'],['Bond','abc',20],['Bond',4,30]]);sheet.getCell('C3').value={formula:'10+20',result:30};sheet.getCell('B2').note='Nota original';
 const buffer=Buffer.from(await book.xlsx.writeBuffer()),source=X.read(buffer);
 const result=await errorWorkbook(buffer,source,[{sheet:'Datos',row:2,field:'calibre',cause:'Debe ser numérico'}]);
 const read=new Excel.Workbook();await read.xlsx.load(result);const out=read.getWorksheet('Datos');assert.equal(out.getCell('B2').value,'abc');assert.equal(out.getCell('B2').fill.fgColor.argb,'FFFF6666');assert.match(typeof out.getCell('B2').note==='string'?out.getCell('B2').note:out.getCell('B2').note.texts.map(t=>t.text).join(''),/Debe ser numérico/);assert.equal(out.getCell('C3').value.formula,'10+20');assert.notEqual(out.getCell('C2').fill?.fgColor?.argb,'FFFF6666');
});
