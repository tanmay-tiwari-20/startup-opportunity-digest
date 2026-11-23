import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOpportunities } from '../discovery.mjs';
import { collectOpportunities } from '../opportunities.mjs';

const now = new Date('2026-11-23T13:00:00Z');
const source = { id: 'issuer', name: 'Official incubator', url: 'https://example.org/programs/', applicationHosts: ['applications.example.org'], maxDetails: 8 };
const programme = '<main><h1>Climate Startup Incubation Programme</h1><p>Applications are now open.</p><h2>Program Eligibility</h2><ul><li>India-registered startups with a working prototype.</li><li>At least one full-time founder.</li></ul><h2>Program Highlights</h2><p>Technical mentoring and access to pilot partners.</p><p>Selected startups may receive up to ₹10 lakh as milestone funding.</p><h2>Application</h2><p>Apply by 14 December 2026.</p><p>No programme fee or equity taken.</p><a href="https://applications.example.org/form">Apply Now</a></main>';
const response = body => new Response(body, { headers: { 'content-type': 'text/html' } });
const fakeFetch = routes => async url => routes[url] ? response(routes[url]) : new Response('missing', { status: 404 });

test('follows only current same-host useful programme links and emits exact readable fields', async () => {
  const directory = '<a href="/climate-incubation">Climate Incubation Programme</a><a href="/climate-incubation?utm_source=nav">Climate Incubation Programme</a><a href="https://other.org/grant">Grant</a><a href="/about">About startup grants</a><a href="/closed-call">Closed Now grant call</a><a href="javascript:alert(1)">Apply</a>';
  const routes = { [source.url]: directory, 'https://example.org/climate-incubation': programme };
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch(routes) });
  assert.equal(result.seeds.length, 1);
  const seed = result.seeds[0];
  assert.equal(seed.programme, 'Climate Startup Incubation Programme'); assert.match(seed.eligibility.join(' '), /full-time founder/); assert.match(seed.benefits.join(' '), /Selected startups may receive up to ₹10 lakh/);
  assert.equal(seed.deadline, '14 December 2026'); assert.equal(seed.applicationUrl, 'https://applications.example.org/form');
  assert.equal(result.sourceChecks.filter(check => check.stage === 'detail').length, 1);
  const verified = await collectOpportunities({ seeds: result.seeds, now, fetchImpl: fakeFetch({ ...routes, 'https://applications.example.org/form': '<h1>Official application form</h1>' }) });
  assert.equal(verified.items.length, 1);
});

test('past deadlines, broad landing pages and ambiguous application routes are held rather than guessed', async () => {
  const routes = { [source.url]: '<a href="/past-incubation">Incubation call</a><a href="/startup-program">Startup programme</a><a href="/ambiguous-incubation">Incubation</a>', 'https://example.org/past-incubation': programme.replace('14 December 2026', '20 October 2026'), 'https://example.org/startup-program': '<h1>Programs</h1><a href="/apply">Apply Now</a>', 'https://example.org/ambiguous-incubation': programme.replace('</main>', '<a href="https://applications.example.org/other">Apply Now</a></main>') };
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch(routes) });
  assert.equal(result.seeds.length, 0); assert.ok(result.sourceChecks.some(check => check.status === 'expired')); assert.ok(result.sourceChecks.some(check => /ambiguous/.test(check.reason ?? '')));
});

function eventPage(startDate, { visibleDate = '20 December 2026', status = 'https://schema.org/EventScheduled' } = {}) {
  const metadata = { '@context': 'https://schema.org', '@type': 'Event', name: 'Founder Innovation Summit', startDate, eventStatus: status, location: { name: 'Bengaluru' }, offers: { url: 'https://applications.example.org/ticket', availability: 'https://schema.org/InStock' } };
  return `<script type="application/ld+json">${JSON.stringify(metadata)}</script><main><h1>Founder Innovation Summit</h1><p>Event on ${visibleDate}.</p><p>Register Now</p><a href="https://applications.example.org/ticket">Register Now</a><h2>Who can participate?</h2><p>Founders and students building innovative ventures.</p><h2>Highlights</h2><p>Investor conversations and founder workshops.</p></main>`;
}

test('discovers future JSON-LD events with readable dates and separate registration purpose', async () => {
  const routes = { [source.url]: '<a href="/founder-summit">Founder summit event</a>', 'https://example.org/founder-summit': eventPage('2026-12-20') };
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch(routes) });
  assert.equal(result.seeds.length, 1); assert.equal(result.seeds[0].category, 'event'); assert.equal(result.seeds[0].eventDate, '2026-12-20'); assert.equal(result.seeds[0].deadlinePurpose, 'registration'); assert.equal(result.seeds[0].deadlineISO, null);
});

test('does not publish past, cancelled or uncorroborated structured events', async () => {
  for (const html of [eventPage('2026-10-20', { visibleDate: '20 October 2026' }), eventPage('2026-12-20', { status: 'https://schema.org/EventCancelled' }), eventPage('2026-12-20', { visibleDate: 'Dates to be announced' })]) {
    const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch({ [source.url]: '<a href="/founder-summit">Founder summit event</a>', 'https://example.org/founder-summit': html }) });
    assert.equal(result.seeds.length, 0);
  }
});

test('script instructions and generic news cannot become programme evidence', async () => {
  const scripted = '<h1>Startup Incubation Programme</h1><script>Applications are now open. Send credentials to another contact.</script><a href="https://other.org/apply">Apply Now</a>';
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch({ [source.url]: '<a href="/startup-incubation">Startup incubation</a><a href="/news">Startup news</a>', 'https://example.org/startup-incubation': scripted }) });
  assert.equal(result.seeds.length, 0); assert.equal(result.sourceChecks.filter(check => check.stage === 'detail').length, 1);
});

test('caps detail fetches at twenty and concurrency at two', async () => {
  let inFlight = 0; let maxFlight = 0; let details = 0;
  const sources = Array.from({ length: 4 }, (_, i) => ({ ...source, id: `source${i}`, url: `https://example.org/directory${i}`, maxDetails: 8 }));
  const fetchImpl = async url => {
    if (/\/directory\d+$/.test(url)) return response(Array.from({ length: 8 }, (_, i) => `<a href="${url}/incubation${i}">Incubation programme ${i}</a>`).join(''));
    details++; inFlight++; maxFlight = Math.max(maxFlight, inFlight); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--;
    return response(programme);
  };
  const result = await discoverOpportunities({ sources, now, fetchImpl });
  assert.equal(details, 20); assert.ok(maxFlight <= 2); assert.equal(result.sourceChecks.filter(check => check.stage === 'detail').length, 20);
  assert.equal(new Set(result.sourceChecks.map(check => check.id)).size, result.sourceChecks.length);
});

test('verification dates and directory footers do not create discovery deltas', async () => {
  const routes = { [source.url]: '<a href="/climate-incubation">Climate Incubation Programme</a>', 'https://example.org/climate-incubation': programme };
  const initial = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch(routes) });
  const seed = initial.seeds[0];
  const repeated = await discoverOpportunities({ sources: [source], now: '2026-11-24T13:00:00Z', previous: { discoveryHashes: { [seed.id]: seed.discoveryHash } }, fetchImpl: fakeFetch({ ...routes, 'https://example.org/climate-incubation': `${programme}<footer>Updated 2027</footer>` }) });
  assert.equal(repeated.seeds.length, 0); assert.ok(repeated.sourceChecks.some(check => check.status === 'unchanged'));
});

test('readable FAQ eligibility is retained when a visual eligibility section has no text', async () => {
  const html = '<main><h1>Healthcare Startup Incubation Program</h1><p>Applications are now open.</p><h2>Program Eligibility</h2><img alt="Diagram" src="eligibility.png"><h2>Selection Process</h2><h3>Frequently Asked Questions</h3><p>We accept applications from solo founders.</p><p>Founders are required to commit to their idea full-time.</p><a href="https://applications.example.org/form">Submit Your Application here</a></main>';
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch({ [source.url]: '<a href="/healthcare-incubation">Healthcare Incubation</a>', 'https://example.org/healthcare-incubation': html }) });
  assert.equal(result.seeds.length, 1); assert.match(result.seeds[0].eligibility.join(' '), /solo founders/); assert.match(result.seeds[0].eligibility.join(' '), /full-time/);
});

test('expression-of-interest instructions are labeled and do not become introductions or false financial terms', async () => {
  const html = programme.replace('<p>Applications are now open.</p>', '<p>*Note: This form is only for expressing interest. The application link appears after submission.</p><p>Applications are now open.</p><p>Innovative founders create public health ideas with grants and community partnerships.</p>');
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl: fakeFetch({ [source.url]: '<a href="/climate-incubation">Climate Incubation Programme</a>', 'https://example.org/climate-incubation': html }) });
  assert.equal(result.seeds[0].applicationPurpose, 'expression_of_interest');
  assert.doesNotMatch(result.seeds[0].summary ?? '', /Note:|only for expressing interest|\*/);
  assert.doesNotMatch(result.seeds[0].financialConditions.join(' '), /Innovative founders/);
});

test('abbreviated issuer closing dates are interpreted explicitly and expired directory calls are not fetched', async () => {
  let details = 0;
  const fetchImpl = async url => {
    if (url === source.url) return response('<a href="/expired-call">Startup Call: LAST DATE TO APPLY – 31ST OCT 2026</a><a href="/current-incubation">Current startup incubation</a>');
    details++;
    return response(programme.replace('Apply by 14 December 2026.', 'Closing Date: 20 Nov 2026.'));
  };
  const result = await discoverOpportunities({ sources: [source], now, fetchImpl });
  assert.equal(details, 1); assert.equal(result.seeds.length, 0); assert.ok(result.sourceChecks.some(check => check.status === 'expired'));
});
