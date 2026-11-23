import test from 'node:test';
import assert from 'node:assert/strict';
import { digestDate, digestIdentity } from '../cloud-main.mjs';
test('daily digest identity uses India calendar across UTC midnight boundaries',()=>{
 assert.equal(digestDate(new Date('2026-11-20T18:45:00Z')),'2026-11-21');
 assert.equal(digestDate(new Date('2026-11-20T12:00:00Z')),'2026-11-20');
});

test('upgrade preview has its own stable daily reservation without replacing daily deduplication',()=>{
 const now=new Date('2026-11-23T12:00:00Z');
 assert.equal(digestIdentity(now),'startup-digest-2026-11-23');
 assert.equal(digestIdentity(now,true),'startup-digest-2026-11-23-opportunities-v2');
 assert.equal(digestIdentity(new Date('2026-11-23T13:00:00Z'),true),digestIdentity(now,true));
});
