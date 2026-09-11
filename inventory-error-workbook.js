const ExcelJS=require('exceljs');
const XLSX=require('xlsx');
const normalize=v=>String(v??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
async function errorWorkbook(buffer,source,errors){
 const book=new ExcelJS.Workbook();
 if(buffer[0]===0x50&&buffer[1]===0x4b)await book.xlsx.load(buffer);
 else for(const name of source.SheetNames){const sheet=book.addWorksheet(name);for(const [address,cell]of Object.entries(source.Sheets[name])){if(address.startsWith('!'))continue;sheet.getCell(address).value=cell.f?{formula:cell.f,result:cell.v}:cell.v;}}
 for(const error of errors){
  let sheet=book.getWorksheet(error.sheet)||book.worksheets[0];if(!sheet)sheet=book.addWorksheet('Errores');
  const original=source.Sheets[sheet.name],range=original?.['!ref']?XLSX.utils.decode_range(original['!ref']):{s:{r:0,c:0},e:{r:0,c:0}};
  const row=error.row||range.s.r+1,columns=[];
  for(let c=range.s.c;c<=range.e.c;c++)if(normalize(original?.[XLSX.utils.encode_cell({r:range.s.r,c:c})]?.v)===normalize(error.field))columns.push(c+1);
  if(!columns.length)for(let c=range.s.c;c<=range.e.c;c++)columns.push(c+1);
  for(const col of columns){const cell=sheet.getCell(row,col);cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFF6666'}};const old=typeof cell.note==='string'?cell.note:(cell.note?.texts||[]).map(t=>t.text).join('');cell.note=[old,`${error.field}: ${error.cause}`].filter(Boolean).join('\n');}
 }
 return Buffer.from(await book.xlsx.writeBuffer());
}
module.exports={errorWorkbook};
