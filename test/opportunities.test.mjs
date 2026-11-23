import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOpportunities, renderOpportunity, safePublicUrl, fetchVerifiedPage } from '../opportunities.mjs';

const now = new Date('2026-11-23T13:00:00Z');
const seed = { id: 'pilot-2026', programme: 'Prototype to Market 2026', organizer: 'Official Incubator', category: 'Pilot grant', sourceUrl: 'https://example.org/call', applicationUrl: 'https://example.org/apply', eligibility: ['DPIIT-recognised startups with a working prototype'], benefits: ['Up to ₹20 lakh per selected startup'], financialConditions: ['Milestone-based grant; no equity taken'], deadline: '14 December 2026', deadlineISO: '2026-12-14T17:00:00+05:30', deadlineTimezone: 'Asia/Kolkata', status: 'open', requiredEvidence: ['DPIIT-recognised startups with a working prototype', 'Up to ₹20 lakh per selected startup', 'Milestone-based grant; no equity taken', '14 December 2026'] };
const page = '<h1>Prototype to Market 2026</h1><p>DPIIT-recognised startups with a working prototype</p><p>Up to ₹20 lakh per selected startup</p><p>Milestone-based grant; no equity taken</p><p>Apply by 14 December 2026</p><a href="/apply">Apply now</a>';
const fixtureFetch = (body = page, handler) => async (url, options) => handler?.(url, options) ?? new Response(url.endsWith('/apply') ? '<h1>Application form</h1>' : body, { status: 200, headers: { 'content-type': 'text/html' } });

test('publishes a rich verified call with precise money and funding conditions', async () => {
  const result = await collectOpportunities({ seeds: [seed], now, fetchImpl: fixtureFetch() });
  assert.equal(result.items.length, 1); assert.equal(result.sourceChecks[0].status, 'verified');
  const rendered = renderOpportunity(result.items[0]);
  assert.match(rendered, /Who can apply: DPIIT/); assert.match(rendered, /Up to ₹20 lakh per selected startup/);
  assert.match(rendered, /Milestone-based grant; no equity taken/); assert.match(rendered, /17:00/);
  assert.match(rendered, /Apply: https:\/\/example.org\/apply/); assert.match(rendered, /Checked: 2026-11-23/);
});

test('changed amounts, deadline or participation terms enter review rather than reusing seed claims', async () => {
  for (const modified of [page.replace('₹20 lakh', '₹10 lakh'), page.replace('14 December', '7 December'), page.replace('no equity taken', '3% equity taken')]) {
    const result = await collectOpportunities({ seeds: [seed], now, fetchImpl: fixtureFetch(modified) });
    assert.equal(result.items.length, 0); assert.equal(result.sourceChecks[0].status, 'review');
    assert.match(result.sourceChecks[0].reason, /evidence is missing or changed/);
  }
});

test('date-only and precisely timed expired calls are not published', async () => {
  const precise = await collectOpportunities({ seeds: [seed], now: '2026-12-14T13:00:00Z', fetchImpl: fixtureFetch() });
  assert.equal(precise.items.length, 0); assert.equal(precise.sourceChecks[0].status, 'expired');
  const dateOnly = await collectOpportunities({ seeds: [{ ...seed, deadlineISO: null, deadline: '22 November 2026' }], now, fetchImpl: fixtureFetch() });
  assert.equal(dateOnly.items.length, 0); assert.equal(dateOnly.sourceChecks[0].status, 'expired');
});

test('rolling applications require explicit current rolling evidence and have no invented cutoff', async () => {
  const rolling = { ...seed, id: 'rolling', deadline: null, deadlineISO: null, status: 'rolling', requiredEvidence: ['Applications accepted on a rolling basis'], benefits: ['Founder mentoring'], financialConditions: ['Optional investment; not a grant'] };
  const result = await collectOpportunities({ seeds: [rolling], now, fetchImpl: fixtureFetch('<p>Applications accepted on a rolling basis</p><a href="/apply">Apply</a>') });
  assert.equal(result.items[0].deadlineDate, null); assert.match(renderOpportunity(result.items[0]), /Rolling applications/);
  const unsupported = await collectOpportunities({ seeds: [{ ...rolling, requiredEvidence: ['Applications open'] }], now, fetchImpl: fixtureFetch('<p>Applications open</p><a href="/apply">Apply</a>') });
  assert.equal(unsupported.items.length, 0); assert.match(unsupported.sourceChecks[0].reason, /Rolling availability/);
});

test('a total prize pool remains a pool; matching investment is never relabeled a grant', async () => {
  const pool = { ...seed, benefits: ['₹1 crore total prize pool'], financialConditions: ['₹10 lakh per winner; matching investment is separate'], requiredEvidence: ['₹1 crore total prize pool', '₹10 lakh per winner; matching investment is separate', '14 December 2026'] };
  const html = '<p>₹1 crore total prize pool</p><p>₹10 lakh per winner; matching investment is separate</p><p>14 December 2026</p><a href="/apply">Apply</a>';
  const result = await collectOpportunities({ seeds: [pool], now, fetchImpl: fixtureFetch(html) });
  const rendered = renderOpportunity(result.items[0]);
  assert.match(rendered, /₹1 crore total prize pool/); assert.match(rendered, /₹10 lakh per winner/); assert.match(rendered, /matching investment is separate/);
});

test('duplicates are suppressed and verification timestamps do not create semantic updates', async () => {
  const result = await collectOpportunities({ seeds: [seed, structuredClone(seed)], now, fetchImpl: fixtureFetch() });
  assert.equal(result.items.length, 1); assert.equal(result.sourceChecks[1].status, 'duplicate');
  const item = result.items[0];
  const next = await collectOpportunities({ seeds: [{ ...seed, verifiedDate: '2026-11-24' }], now: '2026-11-24T13:00:00Z', previous: { seen: { [item.id]: { semanticHash: item.semanticHash } } }, fetchImpl: fixtureFetch() });
  assert.equal(next.items.length, 0); assert.equal(next.sourceChecks[0].status, 'unchanged');
  const changed = { ...seed, benefits: ['Up to ₹25 lakh per selected startup'], requiredEvidence: seed.requiredEvidence.map(value => value.replace('₹20 lakh', '₹25 lakh')) };
  const update = await collectOpportunities({ seeds: [changed], now, previous: { [item.id]: { semanticHash: item.semanticHash } }, fetchImpl: fixtureFetch(page.replace('₹20 lakh', '₹25 lakh')) });
  assert.equal(update.items[0].change, 'updated'); assert.notEqual(update.items[0].semanticHash, item.semanticHash);
});

test('registration deadline and event date have different purposes', async () => {
  const event = { ...seed, category: 'Founder event', deadline: '10 December 2026', deadlineISO: null, eventDate: '15 December 2026', eventLocation: 'Bengaluru', benefits: 'Founder networking', financialConditions: 'Registration required', requiredEvidence: ['Register by 10 December 2026', 'Event on 15 December 2026'] };
  const result = await collectOpportunities({ seeds: [event], now, fetchImpl: fixtureFetch('<p>Register by 10 December 2026</p><p>Event on 15 December 2026</p><a href="/apply">Register</a>') });
  const rendered = renderOpportunity(result.items[0]);
  assert.match(rendered, /Registration deadline: 10 December 2026/); assert.match(rendered, /Event: 15 December 2026 — Bengaluru/); assert.match(rendered, /Register:/);
  const closed = await collectOpportunities({ seeds: [event], now: '2026-12-11T12:00:00Z', fetchImpl: fixtureFetch() });
  assert.equal(closed.items.length, 0); assert.equal(closed.sourceChecks[0].status, 'expired');
});

test('verified calls get at most one labeled approaching-deadline reminder per version', async()=>{
  const first=await collectOpportunities({seeds:[seed],now,fetchImpl:fixtureFetch()});
  const item=first.items[0];
  const old={semanticHash:item.semanticHash,lastSeenAt:now.toISOString()};
  const reminder=await collectOpportunities({seeds:[seed],now:'2026-12-09T13:00:00Z',previous:{seen:{[item.id]:old}},fetchImpl:fixtureFetch()});
  assert.equal(reminder.items[0].change,'reminder'); assert.match(renderOpportunity(reminder.items[0]),/Deadline reminder/);
  const repeated=await collectOpportunities({seeds:[seed],now:'2026-12-10T13:00:00Z',previous:{seen:{[item.id]:{...old,reminderVersion:item.semanticHash}}},fetchImpl:fixtureFetch()});
  assert.equal(repeated.items.length,0);
});

test('an invitation without confirmed registration remains in review',async()=>{
  const result=await collectOpportunities({seeds:[{...seed,status:'registration_invited',category:'event'}],now,fetchImpl:fixtureFetch()});
  assert.equal(result.items.length,0); assert.match(result.sourceChecks[0].reason,/has not been confirmed/);
});

test('private destinations, credentials and unauthorized redirects are rejected before being followed', async () => {
  for (const url of ['http://example.org/call', 'https://localhost/call', 'https://127.0.0.1/call', 'https://[::1]/call', 'https://2130706433/call', 'https://user:pass@example.org/call', 'https://example.org/call?access_token=secret']) assert.throws(() => safePublicUrl(url));
  let requests = 0;
  const redirect = await collectOpportunities({ seeds: [seed], now, fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); } });
  assert.equal(requests, 1); assert.equal(redirect.items.length, 0); assert.equal(redirect.sourceChecks[0].status, 'review');
  const otherHost = await collectOpportunities({ seeds: [seed], now, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://unconfigured.org/call' } }) });
  assert.equal(otherHost.items.length, 0); assert.match(otherHost.sourceChecks[0].reason, /outside the configured/);
});

test('scripts do not satisfy evidence, PDFs need review and unreachable applications are not endorsed', async () => {
  const scripted = await collectOpportunities({ seeds: [seed], now, fetchImpl: fixtureFetch(`<script>${seed.requiredEvidence.join(' ')}</script><a href="/apply">Apply</a>`) });
  assert.equal(scripted.items.length, 0);
  const pdf = await collectOpportunities({ seeds: [seed], now, fetchImpl: async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) });
  assert.equal(pdf.items.length, 0); assert.match(pdf.sourceChecks[0].reason, /PDF notice/);
  const unreachable = await collectOpportunities({ seeds: [seed], now, fetchImpl: fixtureFetch(page, url => url.endsWith('/apply') ? new Response('closed', { status: 404 }) : undefined) });
  assert.equal(unreachable.items.length, 0); assert.match(unreachable.sourceChecks[0].reason, /HTTP 404/);
  const noLink = await collectOpportunities({ seeds: [seed], now, fetchImpl: fixtureFetch(page.replace('<a href="/apply">Apply now</a>', '')) });
  assert.equal(noLink.items.length, 0); assert.match(noLink.sourceChecks[0].reason, /does not substantiate/);
});

test('prototype-like ids cannot mutate object prototypes or bypass material verification', async () => {
  const result = await collectOpportunities({ seeds: [{ ...seed, id: '__proto__' }], now, previous: JSON.parse('{"__proto__":{"semanticHash":"fake"}}'), fetchImpl: fixtureFetch() });
  assert.equal(result.items[0].id, 'opportunity:__proto__'); assert.equal({}.semanticHash, undefined);
  const noEvidence = await collectOpportunities({ seeds: [{ ...seed, requiredEvidence: [] }], now, fetchImpl: fixtureFetch() });
  assert.equal(noEvidence.items.length, 0);
  const conflictingDate = await collectOpportunities({ seeds: [{ ...seed, deadline: '15 December 2026' }], now, fetchImpl: fixtureFetch() });
  assert.equal(conflictingDate.items.length, 0); assert.match(conflictingDate.sourceChecks[0].reason, /conflicts/);
});

test('a seed cannot publish an unsupported amount just because general open-call evidence matches', async () => {
  const result = await collectOpportunities({ seeds: [{ ...seed, requiredEvidence: ['Applications open'] }], now, fetchImpl: fixtureFetch('<p>Applications open</p><a href="/apply">Apply</a>') });
  assert.equal(result.items.length, 0); assert.match(result.sourceChecks[0].reason, /monetary amount/);
});

test('suffix euro units and adjacent ticket prices retain all supported amounts',async()=>{
  const current={...seed,benefits:'Pilot up to €200,000; evaluation up to €1.5 million',financialConditions:'Passes ₹2,700 or ₹6,000',requiredEvidence:['Applications open','200k€','1,5m€','₹ 2,700','₹ 6,000']};
  const html='<p>Applications open. Pilot up to 200k€. Impact evaluation up to 1,5m€.</p><p>₹ 5,000 ₹ 2,700 ₹ 12,500 ₹ 6,000</p><a href="/apply">Apply</a>';
  const result=await collectOpportunities({seeds:[current],now,fetchImpl:fixtureFetch(html)});
  assert.equal(result.items.length,1);
});

test('a legacy official HTTP form link is checked through its secure equivalent',async()=>{
  const current={...seed,applicationUrl:'https://forms.example.org/apply'};
  const html=page.replace('href="/apply"','href="http://forms.example.org/apply"');
  const result=await collectOpportunities({seeds:[current],now,fetchImpl:fixtureFetch(html)});
  assert.equal(result.items.length,1); assert.equal(result.items[0].applicationUrl,current.applicationUrl);
});

test('expressing interest is labeled separately from a final application',async()=>{
  const result=await collectOpportunities({seeds:[{...seed,applicationPurpose:'expression_of_interest'}],now,fetchImpl:fixtureFetch()});
  const rendered=renderOpportunity(result.items[0]);
  assert.match(rendered,/Express interest: https/); assert.doesNotMatch(rendered,/\nApply:/);
});

test('secondary official evidence verifies funding ceilings expressed in equivalent currency units', async () => {
  const supplemented = { ...seed, sourceUrl: 'https://example.org/notice', requiredEvidence: ['Applications open'], evidenceSources: [{ url: 'https://example.org/terms', requiredEvidence: ['INR 20,00,000'] }] };
  const fetchImpl = async url => new Response(url.endsWith('/terms') ? '<p>INR 20,00,000 milestone grant</p>' : '<p>Applications open</p><a href="/apply">Apply</a>', { headers: { 'content-type': 'text/html' } });
  const result = await collectOpportunities({ seeds: [supplemented], now, fetchImpl });
  assert.equal(result.items.length, 1); assert.equal(result.sourceChecks[0].evidenceSources.length, 1);
});

test('unspecified deadlines and approximate programme dates remain descriptive, with date-only ISO accepted', async () => {
  const unknown = { ...seed, deadline: 'Closing date not stated; applications are currently open.', deadlineISO: null, eventDate: 'June 2027 programme launch', status: 'registration_open' };
  const result = await collectOpportunities({ seeds: [unknown], now, fetchImpl: fixtureFetch() });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].deadlineDate, null); assert.match(renderOpportunity(result.items[0]), /June 2027 programme launch/);
  const dateOnly = await collectOpportunities({ seeds: [{ ...seed, deadlineISO: '2026-12-14' }], now, fetchImpl: fixtureFetch() });
  assert.equal(dateOnly.items.length, 1); assert.equal(dateOnly.items[0].deadlineISO, null); assert.doesNotMatch(renderOpportunity(dateOnly.items[0]), /17:00/);
});

test('programme date ranges never turn an accelerator application into event registration or duplicate closing times', async () => {
  const programme = { ...seed, category: 'accelerator', deadline: '14 December 2026, 5:00 p.m. IST', eventDate: '27 January–2 April 2027' };
  const result = await collectOpportunities({ seeds: [programme], now, fetchImpl: fixtureFetch() });
  const rendered = renderOpportunity(result.items[0]);
  assert.match(rendered, /Application deadline:/); assert.match(rendered, /Programme dates: 27 January–2 April 2027/); assert.match(rendered, /Apply:/);
  assert.doesNotMatch(rendered, /Registration deadline|Register:|17:00/);
});

test('conflicting duplicate ids are all held for review before any call is selected', async () => {
  const result = await collectOpportunities({ seeds: [seed, { ...seed, benefits: '₹30 lakh grant' }], now, fetchImpl: fixtureFetch() });
  assert.equal(result.items.length, 0); assert.equal(result.sourceChecks.every(check => check.status === 'review'), true);
});

test('validated page wrapper permits only configured public issuer hosts', async () => {
  const result = await fetchVerifiedPage({ url: seed.sourceUrl, allowedHosts: new Set(['example.org']), fetchImpl: fixtureFetch() });
  assert.equal(result.httpStatus, 200); assert.match(result.body, /working prototype/);
  await assert.rejects(() => fetchVerifiedPage({ url: seed.sourceUrl, allowedHosts: ['other-issuer.org'], fetchImpl: fixtureFetch() }), /outside the configured issuer/);
});
