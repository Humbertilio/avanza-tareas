const {test}=require('node:test'),assert=require('node:assert/strict');
const {migrateClients}=require('../client-directory');
const {applyOperation,clients}=require('../field-visits');
const {randomUUID}=require('node:crypto');
test('migration preserves client IDs, coordinates, visit and chat references and is idempotent',()=>{
 const db={meta:{},companies:[{id:'company-one',name:'Empresa',phone:'123'}],fieldClients:[{id:'field-one',name:'Tienda',point:{latitude:1,longitude:2},contact:'Ana'}],customerLocations:{'company-one':{point:{latitude:3,longitude:4}}},fieldVisits:[{clientId:'field-one'}],conversations:[{companyId:'company-one'}]};
 assert.equal(migrateClients(db),true);assert.equal(db.companies.length,2);assert.equal(db.companies[0].point.latitude,3);assert.equal(db.companies[1].id,db.fieldVisits[0].clientId);assert.equal(db.companies[0].id,db.conversations[0].companyId);assert.equal(db.fieldClients,undefined);assert.equal(db.customerLocations,undefined);const snapshot=JSON.stringify(db);assert.equal(migrateClients(db),false);assert.equal(JSON.stringify(db),snapshot);
});
test('new seller clients are canonical companies and company edits are visible in Jornada',()=>{
 const db={companies:[]},id=randomUUID();applyOperation(db,{id:'seller',role:'seller'},{id:randomUUID(),type:'client',data:{id,name:'Nueva',point:{latitude:0,longitude:0},createdAt:new Date().toISOString()}});
 assert.equal(db.companies[0].id,id);db.companies[0].name='Actualizada';db.companies[0].phone='555';assert.equal(clients(db)[0].name,'Actualizada');assert.equal(clients(db)[0].phone,'555');assert.equal(db.fieldClients,undefined);
});
