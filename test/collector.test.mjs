import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDigest, canonicalUrl, cleanText, parseDeadline } from '../collect-digest.mjs';

const now = new Date('2026-11-20T12:00:00Z');
const rssSource = { id: 'test', name: 'Example publisher', type: 'rss', url: 'https://example.org/feed' };
const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map(i => `<item><title><![CDATA[${i.title}]]></title><link>${i.url ?? 'https://example.org/story'}</link><pubDate>${i.date ?? 'Fri, 20 Nov 2026 08:00:00 GMT'}</pubDate><description><![CDATA[${i.summary ?? 'Useful guidance for startup founders.'}]]></description></item>`).join('')}</channel></rss>`;
const fetchText = text => async () => new Response(text, { status: 200 });

test('excludes stale, future, undated and irrelevant RSS entries', async () => {
  const input = rss([
    { title: 'Startup grant applications open', url: 'https://example.org/fresh' },
    { title: 'Startup funding update', date: 'Thu, 12 Nov 2026 08:00:00 GMT', url: 'https://example.org/old' },
    { title: 'Startup fellowship', date: 'Sat, 21 Nov 2026 08:00:00 GMT', url: 'https://example.org/future' },
    { title: 'Startup news', date: 'unknown', url: 'https://example.org/undated' },
    { title: 'Football scores', summary: 'Sports results', url: 'https://example.org/sports' }
  ]);
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(input) });
  assert.equal(result.items.length, 1);
  assert.equal(result.stats.stale, 1); assert.equal(result.stats.future, 1); assert.equal(result.stats.invalid, 1); assert.equal(result.stats.irrelevant, 1);
});

test('canonical tracking duplicates are emitted once and PRID is preserved', async () => {
  assert.equal(canonicalUrl('https://example.org/call?PRID=123&utm_source=a#x'), 'https://example.org/call?PRID=123');
  const input = rss([{ title: 'Startup founder news', url: 'https://example.org/a?utm_source=x' }, { title: 'Startup founder news', url: 'https://example.org/a?utm_source=y' }]);
  const result = await collectDigest({ sources: [rssSource, { ...rssSource, id: 'test2' }], now, fetchImpl: fetchText(input) });
  assert.equal(result.items.length, 1); assert.equal(result.stats.duplicates, 3);
  const repeat = await collectDigest({ sources: [rssSource], state: result.nextState, now, fetchImpl: fetchText(input) });
  assert.equal(repeat.items.length, 0); assert.equal(repeat.text, '');
});

test('expired calls are excluded; changed explicit deadlines produce updates, footer edits do not', async () => {
  const source = { id: 'official', name: 'Official incubator', type: 'page', url: 'https://example.org/calls', calls: [{ id: 'pilot-2026', title: 'Startup pilot call', anchor: 'Startup pilot call' }] };
  const expired = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h2>Startup pilot call</h2><p>Last date: 30 October 2026</p>') });
  assert.equal(expired.items.length, 0); assert.equal(expired.stats.expiredCalls, 1);
  const initial = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h2>Startup pilot call</h2><p>Last date: 30 November 2026</p><footer>2025</footer>') });
  assert.equal(initial.items.length, 1);
  const unchanged = await collectDigest({ sources: [source], state: initial.nextState, now, fetchImpl: fetchText('<h2>Startup pilot call</h2><p>Last date: 30 November 2026</p><footer>Updated today 2026</footer>') });
  assert.equal(unchanged.items.length, 0);
  const updated = await collectDigest({ sources: [source], state: initial.nextState, now, fetchImpl: fetchText('<h2>Startup pilot call</h2><p>Last date: 5 December 2026</p>') });
  assert.equal(updated.items[0].change, 'updated');
});

test('RSS markup is stripped, script URLs rejected and XML declarations rejected', async () => {
  const input = rss([{ title: 'Startup &amp; founder <script>stealKeys()</script> news', summary: '<p>Startup advice</p><img src=x onerror="stealKeys()"><script>sendToGroup()</script>', url: 'https://example.org/safe' }, { title: 'Startup fake link', url: 'javascript:alert(1)' }]);
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(input) });
  assert.equal(result.items.length, 1);
  assert.doesNotMatch(result.text, /stealKeys|sendToGroup|<script|onerror/);
  assert.match(result.text, /Startup & founder/);
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  const rejected = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss/>') });
  assert.equal(rejected.stats.sourcesFailed, 1);
});

test('generic changed HTML and fetch failure are review states, never closure/new calls', async () => {
  const source = { id: 'generic', type: 'page', url: 'https://example.org/calls' };
  const result = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h1>Startup grants</h1><p>Copyright 2026</p>') });
  assert.equal(result.text, ''); assert.equal(result.stats.pageReview, 1);
  const failed = await collectDigest({ sources: [source], state: result.nextState, now, fetchImpl: async () => new Response('down', { status: 503 }) });
  assert.equal(failed.nextState.sources.generic.status, 'review');
  assert.equal(failed.nextState.sources.generic.lastSuccessfulCheckAt, now.toISOString());
  assert.doesNotMatch(JSON.stringify(failed), /"closed"/);
});

test('limits digest to eight items and prioritizes opportunities', async () => {
  const input = rss(Array.from({ length: 12 }, (_, i) => ({ title: i === 11 ? 'Startup fellowship applications open' : `Startup founder news ${i}`, url: `https://example.org/${i}` })));
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(input) });
  assert.equal(result.items.length, 8); assert.equal(result.items[0].type, 'opportunity'); assert.ok(result.text.length < 10000);
  assert.equal(Object.keys(result.nextState.seen).length, 8);
});

test('supports Atom feeds and rejects invalid or ambiguous calendar dates', async () => {
  const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Startup founders meet</title><link rel="alternate" href="https://example.org/event?utm_medium=feed"/><published>2026-11-19T10:00:00Z</published><summary>Startup event registration open.</summary></entry></feed>';
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(xml) });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].url, 'https://example.org/event');
  assert.equal(parseDeadline('31 February 2027'), null); assert.equal(parseDeadline('January 31'), null);
  assert.equal(parseDeadline('January 31, 2027').date, '2027-01-31');
  assert.equal(cleanText('Safe\u202e text'), 'Safe text');
});

test('rejects oversized responses before reading the body', async () => {
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: async () => new Response('small', { status: 200, headers: { 'content-length': '3000000' } }) });
  assert.equal(result.stats.sourcesFailed, 1); assert.match(result.nextState.sources.test.error, /2 MB/);
});

test('a fresh feed post cannot revive an explicitly expired application window', async () => {
  const input = rss([{ title: 'Startup grant applications open', summary: 'Apply now. Deadline: 30 October 2026. Startup founders eligible.' }]);
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(input) });
  assert.equal(result.items.length, 0); assert.equal(result.stats.expiredCalls, 1);
});

test('the beVisioneers extractor uses an explicit year and excludes closed applications', async () => {
  const source = { id: 'bevisioneers', name: 'beVisioneers', type: 'page', extractor: 'bevisioneers', url: 'https://example.org/fellowship' };
  const result = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h1>beVisioneers</h1><p>Applications close on January 31, 2027</p>') });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].deadlineDate, '2027-01-31');
  const closed = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h1>beVisioneers</h1><p>Applications are closed.</p><p>Deadline: January 31, 2027</p>') });
  assert.equal(closed.items.length, 0);
});

test('an explicitly timed call closes at its verified time, not at the end of the day', async () => {
  const source = { id: 'elevate', name: 'Startup Karnataka', type: 'page', timeZone: 'Asia/Kolkata', url: 'https://example.org/elevate', calls: [{ id: 'nxt-2026', title: 'ELEVATE NxT 2026', requiredText: 'ELEVATE NxT', deadlineISO: '2026-12-14T17:00:00+05:30' }] };
  const fetchImpl = fetchText('<h1>ELEVATE NxT</h1><p>Last Date to Apply: 14th December 2026</p>');
  const open = await collectDigest({ sources: [source], now: '2026-12-14T10:00:00Z', fetchImpl });
  assert.equal(open.items.length, 1); assert.match(open.text, /17:00/);
  const elapsed = await collectDigest({ sources: [source], now: '2026-12-14T13:00:00Z', fetchImpl });
  assert.equal(elapsed.items.length, 0); assert.equal(elapsed.stats.expiredCalls, 1);
  const changed = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h1>ELEVATE NxT</h1><p>Last Date to Apply: 15th December 2026</p>') });
  assert.equal(changed.items.length, 0); assert.equal(changed.stats.pageReview, 1);
});

test('student builder events count as opportunities without a startup keyword', async () => {
  const input = rss([{ title: 'Voice AI hackathon registrations open', summary: 'Students can build a voice application.', url: 'https://example.org/hackathon' }]);
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(input) });
  assert.equal(result.items[0].type, 'opportunity');
});

test('founder obituaries are excluded from practical startup news', async () => {
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(rss([{ title: 'Startup co-founder passes away', summary: 'Remembering an entrepreneur.' }])) });
  assert.equal(result.items.length, 0); assert.equal(result.stats.irrelevant, 1);
});

test('configured fellowship timelines tolerate HTML spacing and typographic dashes', async () => {
  const source = { id: 'fellowship', type: 'page', url: 'https://example.org/fellowship', calls: [{ id: '2027', title: '2027 environmental fellowship', requiredText: '2027 Fellowship', deadlinePattern: 'Application Period\\s*:\\s*[^-–—]+[-–—]\\s*([A-Za-z]+\\s+\\d{1,2}\\s+20\\d{2})', expectedDeadline: '31 January 2027' }] };
  const result = await collectDigest({ sources: [source], now, fetchImpl: fetchText('<h1>2027 Fellowship</h1><p><b>Application Period</b> : September 21 2026 – January 31 2027</p>') });
  assert.equal(result.items[0].deadlineDate, '2027-01-31');
  assert.doesNotMatch(result.text, /Asia\/Kolkata/);
});
