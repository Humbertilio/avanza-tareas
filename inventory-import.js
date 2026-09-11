const XLSX = require('xlsx');
const crypto = require('node:crypto');
const normalize = value => String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const fields = ['material','calibre','ancho','peso','gramaje','ubicacion','id','observacion','destino'];
function importInventory(db, workbook, metadata, validate, hash) {
  const errors = [], pending = [], sheets = [];
  const ids = new Map(), hashes = new Map();
  for (const item of db.inventoryItems) {
    if (item.externalId) ids.set(item.externalId.toLowerCase(), 'el inventario');
    hashes.set(item.rowHash || hash(item), 'el inventario');
  }
  const add = (sheet,row,field,value,cause) => errors.push({sheet,row,field,value:String(value ?? ''),cause});
  for (const sheet of workbook.SheetNames) {
    const ws = workbook.Sheets[sheet], range = ws['!ref'] && XLSX.utils.decode_range(ws['!ref']);
    if (!range) continue;
    const headers = new Set();
    for(let col=range.s.c;col<=range.e.c;col++) {
      const cell=ws[XLSX.utils.encode_cell({r:range.s.r,c:col})], name=normalize(cell?.v);
      if (!name) continue;
      if (headers.has(name)) add(sheet,range.s.r+1,name,cell.v,'Encabezado repetido');
      headers.add(name);
    }
    if (!headers.has('material')) add(sheet,range.s.r+1,'Material','','Falta el encabezado Material');
    const rows = XLSX.utils.sheet_to_json(ws,{defval:''});
    if (rows.length>10000) add(sheet,null,'Hoja',rows.length,'Supera el máximo de 10000 registros por hoja; divida los datos en varias hojas');
    sheets.push({sheetName:sheet,imported:rows.length,skipped:0});
    for (const row of rows) {
      const number=row.__rowNum__+1, values=Object.fromEntries(Object.entries(row).map(([key,value])=>[normalize(key),value]));
      const before=errors.length;
      for(const field of fields) {
        try { validate({material:'TEST',[field]:values[field]}); }
        catch(error){ add(sheet,number,field,values[field],error.message); }
      }
      for(let col=range.s.c;col<=range.e.c;col++) {
        const cell=ws[XLSX.utils.encode_cell({r:number-1,c:col})];
        if(cell?.t==='e') add(sheet,number,String(ws[XLSX.utils.encode_cell({r:range.s.r,c:col})]?.v||XLSX.utils.encode_col(col)),cell.w||cell.v,'La celda contiene un error de Excel');
      }
      if(errors.length!==before)continue;
      const item=validate(values),rowHash=hash(item),id=item.externalId.toLowerCase();
      if(id && ids.has(id))add(sheet,number,'ID',item.externalId,'ID duplicado en '+ids.get(id));
      if(hashes.has(rowHash))add(sheet,number,'Registro','', 'Registro duplicado en '+hashes.get(rowHash));
      const location=`${sheet}, fila ${number}`;
      if(id&&!ids.has(id))ids.set(id,location);
      if(!hashes.has(rowHash))hashes.set(rowHash,location);
      pending.push({...item,rowHash});
    }
  }
  if(!pending.length&&!errors.length)add('',null,'Archivo','','El archivo no contiene registros');
  if(errors.length)throw Object.assign(new Error(`No se importó ningún registro. Se encontraron ${errors.length} errores.`),{status:422,errors});
  const now=new Date().toISOString();
  db.inventoryItems.push(...pending.map(item=>({id:crypto.randomUUID(),...item,active:true,createdAt:now,updatedAt:now})));
  for(const sheet of sheets) db.inventoryImports.push({id:crypto.randomUUID(),...metadata,sheetName:sheet.sheetName,importedRows:sheet.imported,skippedRows:0,importedAt:now});
  return {imported:pending.length,skipped:0,sheets};
}
module.exports={importInventory};
