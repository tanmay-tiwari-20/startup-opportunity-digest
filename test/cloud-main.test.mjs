import test from 'node:test';
import assert from 'node:assert/strict';
import { digestDate } from '../cloud-main.mjs';
test('daily digest identity uses India calendar across UTC midnight boundaries',()=>{
 assert.equal(digestDate(new Date('2026-11-20T18:45:00Z')),'2026-11-21');
 assert.equal(digestDate(new Date('2026-11-20T12:00:00Z')),'2026-11-20');
});
