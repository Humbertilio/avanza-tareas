'use strict';
// One canonical company/customer record; preserve IDs referenced by visits and chats.
function migrateClients(db) {
  db.meta ||= {}; db.companies ||= [];
  if(db.meta.unifiedClients === 1)return false;
  for(const legacy of db.fieldClients || []) {
    let company=db.companies.find(c=>c.id===legacy.id);
    if(!company){company={...legacy,status:'registered',taxId:legacy.taxId||''};delete company.source;db.companies.push(company);}
    else for(const [key,value] of Object.entries(legacy))if(company[key]==null&&key!=='source')company[key]=value;
  }
  for(const company of db.companies) {
    const location=db.customerLocations?.[company.id];
    if(!company.point&&location?.point)Object.assign(company,{point:location.point,locationUpdatedAt:location.updatedAt,locationUpdatedBy:location.updatedBy});
  }
  delete db.fieldClients;delete db.customerLocations;
  db.meta.unifiedClients=1;
  return true;
}
module.exports={migrateClients};
