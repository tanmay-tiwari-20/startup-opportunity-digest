import fs from 'node:fs/promises';
import path from 'node:path';

const accepted = status => ['accepted','sent','server_acknowledged','delivered','read'].includes(status);
const validId = id => /^startup-digest-\d{4}-\d{2}-\d{2}(?:-opportunities-v2)?$/.test(id);
async function atomicJSON(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});
  await fs.rename(temporary,file);
}
function transactionFile(dataDir,id){
  if(!validId(id))throw new Error('Invalid digest transaction identity');
  return path.join(dataDir,'digests',`${id}-collection.json`);
}

export async function prepareCollection({dataDir,digestId,result,now=new Date()}){
  const record={schemaVersion:1,digestId,preparedAt:new Date(now).toISOString(),nextState:result.nextState,items:result.items.map(item=>({id:item.id,semanticHash:item.semanticHash}))};
  await atomicJSON(transactionFile(dataDir,digestId),record);
  return record;
}

export async function commitCollection({dataDir,record,response,reconciled=false}){
  if(!accepted(response?.status))throw new Error('Cannot advance a collection without an accepted send');
  const file=transactionFile(dataDir,record.digestId);
  if(record.schemaVersion!==1 || !record.nextState?.seen)throw new Error('Invalid pending collection state');
  await atomicJSON(path.join(dataDir,'seen.json'),record.nextState);
  await atomicJSON(path.join(dataDir,'digests',`${record.digestId}-receipt.json`),{digestId:record.digestId,items:record.items,response,reconciled});
  await fs.unlink(file);
}

export async function reconcileCollections({dataDir,statusLookup}){
  let names;
  try{names=await fs.readdir(path.join(dataDir,'digests'));}catch(error){if(error.code==='ENOENT')return {committed:0,unreserved:0};throw error;}
  const records=[];
  for(const name of names.filter(name=>/^startup-digest-\d{4}-\d{2}-\d{2}(?:-opportunities-v2)?-collection\.json$/.test(name))){
    const record=JSON.parse(await fs.readFile(path.join(dataDir,'digests',name),'utf8'));
    if(path.basename(transactionFile(dataDir,record.digestId))!==name || record.schemaVersion!==1 || !record.nextState?.seen)throw new Error('Invalid pending collection; preserve state for recovery');
    records.push(record);
  }
  const result={committed:0,unreserved:0};
  for(const record of records.sort((a,b)=>a.preparedAt.localeCompare(b.preparedAt))){
    const response=await statusLookup(record.digestId);
    if(!response){
      // No reservation exists. Discard the unsent snapshot and research fresh content again.
      await fs.unlink(transactionFile(dataDir,record.digestId));result.unreserved++;continue;
    }
    if(!accepted(response.status))throw new Error('An earlier digest has an uncertain send outcome. Preserve its pending collection and reconcile before any new edition.');
    await commitCollection({dataDir,record,response,reconciled:true});result.committed++;
  }
  return result;
}
