import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareCollection,commitCollection,reconcileCollections} from '../publication-state.mjs';

async function workspace(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'digest-transaction-'));
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('digest-transaction-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}
const digestId='startup-digest-2026-11-23';
const result={items:[{id:'url:article',semanticHash:'version'}],nextState:{schemaVersion:1,seen:{'url:article':{semanticHash:'version',url:'https://example.org/story'}}}};

test('an accepted send with a lost checkpoint commits its prepared collection on the next run',async t=>{
  const dataDir=await workspace(t);
  await prepareCollection({dataDir,digestId,result});
  const recovery=await reconcileCollections({dataDir,statusLookup:async id=>{assert.equal(id,digestId);return {status:'server_acknowledged'};}});
  assert.equal(recovery.committed,1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir,'seen.json'),'utf8')),result.nextState);
  assert.equal((await fs.readdir(path.join(dataDir,'digests'))).some(name=>name.endsWith('-collection.json')),false);
});

test('a prior-day uncertain reservation blocks new editions without discarding candidate state',async t=>{
  const dataDir=await workspace(t);
  await prepareCollection({dataDir,digestId,result});
  await assert.rejects(reconcileCollections({dataDir,statusLookup:async()=>({status:'uncertain'})}),/earlier digest.*uncertain/);
  await fs.access(path.join(dataDir,'digests',`${digestId}-collection.json`));
  await assert.rejects(fs.access(path.join(dataDir,'seen.json')));
});

test('an unsent snapshot with no reservation is discarded for fresh research, without publishing it',async t=>{
  const dataDir=await workspace(t);
  await prepareCollection({dataDir,digestId,result});
  assert.equal((await reconcileCollections({dataDir,statusLookup:async()=>null})).unreserved,1);
  await assert.rejects(fs.access(path.join(dataDir,'seen.json')));
});

test('ordinary commits require accepted delivery and record the receipt before removing pending state',async t=>{
  const dataDir=await workspace(t);
  const record=await prepareCollection({dataDir,digestId,result});
  await assert.rejects(commitCollection({dataDir,record,response:{status:'uncertain'}}),/accepted send/);
  await commitCollection({dataDir,record,response:{status:'accepted',deliveryConfirmed:false}});
  const receipt=JSON.parse(await fs.readFile(path.join(dataDir,'digests',`${digestId}-receipt.json`),'utf8'));
  assert.equal(receipt.response.deliveryConfirmed,false);assert.equal(receipt.items.length,1);
});
