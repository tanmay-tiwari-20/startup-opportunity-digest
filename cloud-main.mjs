import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { collectDigest } from './collect-digest.mjs';
import { prepareCollection, commitCollection, reconcileCollections } from './publication-state.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.resolve(process.env.DATA_DIR || path.join(ROOT,'data'));
const PORT=Number(process.env.WHATSAPP_RELAY_PORT || 18764);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const success=status=>['accepted','sent','server_acknowledged','delivered','read'].includes(status);
export function digestDate(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 return ['year','month','day'].map(key=>parts.find(p=>p.type===key).value).join('-');
}
export function digestIdentity(now=new Date(),opportunityPreview=false){
 return `startup-digest-${digestDate(now)}${opportunityPreview ? '-opportunities-v2' : ''}`;
}
async function writeJSON(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temporary,file);
}
async function readState(){
 try{return JSON.parse(await fs.readFile(path.join(DATA,'seen.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw new Error('The collection state is invalid');}
}
async function health(){
 try{const r=await fetch(`http://127.0.0.1:${PORT}/health`,{signal:AbortSignal.timeout(5000)});return r.ok?await r.json():null;}catch{return null;}
}
async function prepareConfig(){
 const encoded=process.env.AUTH_KEY_BASE64;
 if(!encoded)throw new Error('AUTH_KEY_BASE64 must be supplied through a protected secret');
 const key=Buffer.from(encoded,'base64');if(key.length!==32)throw new Error('The authentication key is invalid');
 const config=path.join(DATA,'config');await fs.mkdir(config,{recursive:true,mode:0o700});
 for(const name of ['auth-state.enc','outbox.enc']){try{await fs.access(path.join(config,name));}catch{throw new Error('No saved encrypted session. Initialise through the approved deployment procedure.');}}
 const token=process.env.CONTROL_TOKEN || randomBytes(48).toString('hex');
 await fs.writeFile(path.join(config,'auth-key.bin'),key,{mode:0o600});
 await fs.writeFile(path.join(config,'control-token.txt'),token,{mode:0o600});
 return token;
}
async function post(token,payload){
 const r=await fetch(`http://127.0.0.1:${PORT}/send`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload),signal:AbortSignal.timeout(75000)});
 const result=await r.json();if(!r.ok||!success(result.status))throw new Error(result.error || `Delivery state: ${result.status || 'unknown'}. Do not blindly resend.`);
 return result;
}
async function getStatus(token,id){
 const r=await fetch(`http://127.0.0.1:${PORT}/status?digestId=${encodeURIComponent(id)}`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
 if(r.status===404)return null;if(!r.ok)throw new Error('Cannot reconcile prior delivery');return r.json();
}
async function stopChild(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(7000)]);
 if(child.exitCode===null)throw new Error('Relay has not stopped. Do not checkpoint or start another sender yet.');
}
export async function run({dryRun=false,now=new Date(),opportunityPreview=process.env.DIGEST_OPPORTUNITY_PREVIEW==='true'}={}){
 const sources=JSON.parse(await fs.readFile(path.join(ROOT,'sources.json'),'utf8'));
 const seeds=JSON.parse(await fs.readFile(path.join(ROOT,'opportunity-seeds.json'),'utf8'));
 const discoverySources=JSON.parse(await fs.readFile(path.join(ROOT,'discovery-sources.json'),'utf8'));
 const id=digestIdentity(now,opportunityPreview);
 const collect=async()=>collectDigest({sources,seeds,discoverySources,state:await readState(),now});
 if(dryRun){const result=await collect();await writeJSON(path.join(DATA,'research','preview.json'),result);console.log(JSON.stringify({dryRun:true,sending:false,stats:result.stats}));return result;}
 const token=await prepareConfig();
 const existing=await health();if(existing)throw new Error('This batch run needs its own relay; another service already uses the selected port.');
 const child=spawn(process.execPath,[path.join(ROOT,'relay.mjs')],{cwd:ROOT,env:{...process.env,DATA_DIR:DATA,WHATSAPP_RELAY_BIND_HOST:'127.0.0.1'},stdio:'ignore'});
 let childFailure;child.on('error',()=>{childFailure=true;});
 try{
   let ready=false;
   for(let attempt=0;attempt<60;attempt++){
    if(childFailure||child.exitCode!==null)throw new Error('The cloud relay stopped during startup');
    const current=await health();
    if(current?.connected){ready=true;break;}
    if(current&&['needs_pairing','storage_error','reconnect_stopped'].includes(current.connection))throw new Error('The cloud WhatsApp session needs repair or pairing');
    if(current?.qrAvailable)throw new Error('The saved session is unpaired; a QR must be linked privately, never in public workflow logs');
    await pause(1000);
   }
   if(!ready)throw new Error('WhatsApp did not reconnect within one minute');
   const reconciled=await reconcileCollections({dataDir:DATA,statusLookup:digestId=>getStatus(token,digestId)});
   if(reconciled.committed || reconciled.unreserved)console.log(JSON.stringify({collectionRecovery:reconciled}));
   const initialize=process.env.DIGEST_INITIALIZE_ONLY==='true';
   if(!initialize){
    const previous=await getStatus(token,id);
    if(previous){
     if(!success(previous.status))throw new Error('A previous send is reserved with an uncertain outcome. Manual reconciliation is required.');
     console.log(JSON.stringify({digestId:id,status:previous.status,duplicate:true,sending:false}));return {skipped:true};
    }
   }
   const result=await collect();
   await writeJSON(path.join(DATA,'research','last-check.json'),{checkedAt:now.toISOString(),stats:result.stats});
   if(initialize){
    const response=await post(token,{digestId:`cloud-feed-linked-${digestDate(now)}`,text:'Your free cloud startup feed is linked. Daily runs are scheduled for 6:30 PM IST and may arrive later when GitHub is busy. Updates go only to your Message yourself chat. This version uses source feeds and verified call monitors, with no paid AI API.'});
    await writeJSON(path.join(DATA,'seen.json'),result.nextState);
    await writeJSON(path.join(DATA,'digests','initialization.json'),{initializedAt:now.toISOString(),response});
    console.log(JSON.stringify({initialized:true,status:response.status,deliveryConfirmed:response.deliveryConfirmed}));return result;
   }
   if(!result.text){await writeJSON(path.join(DATA,'seen.json'),result.nextState);console.log(JSON.stringify({digestId:id,items:0,sending:false,stats:result.stats}));return result;}
   const payload={digestId:id,text:result.text};await writeJSON(path.join(DATA,'digests',`${id}.json`),payload);
   const transaction=await prepareCollection({dataDir:DATA,digestId:id,result,now});
   const response=await post(token,payload);
   await commitCollection({dataDir:DATA,record:transaction,response});
   console.log(JSON.stringify({digestId:id,items:result.items.length,status:response.status,deliveryConfirmed:response.deliveryConfirmed,stats:result.stats}));return result;
 }finally{
   await stopChild(child);
   // These are reconstructed from the protected secret on the next run and
   // must never enter a cache, an artifact or a repository commit.
   await fs.unlink(path.join(DATA,'config','auth-key.bin')).catch(()=>{});
   await fs.unlink(path.join(DATA,'config','control-token.txt')).catch(()=>{});
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run({dryRun:process.argv.includes('--dry-run')}).catch(error=>{console.error(error.name==='TimeoutError'?'Delivery timeout; preserve encrypted state and reconcile before retrying.':error.message);process.exitCode=1;});
