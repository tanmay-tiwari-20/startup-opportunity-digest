import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDigest, selectDigestItems, similarHeadline, canonicalUrl, cleanText, parseDeadline } from '../collect-digest.mjs';

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

test('news cannot fill the digest or repeat the same publisher', async () => {
  const input = rss(Array.from({ length: 12 }, (_, i) => ({ title: i === 11 ? 'Startup fellowship applications open' : `Startup founder news ${i}`, url: `https://example.org/${i}` })));
  const result = await collectDigest({ sources: [rssSource], now, fetchImpl: fetchText(input) });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].type, 'opportunity'); assert.ok(result.text.length < 10000);
  assert.equal(Object.keys(result.nextState.seen).length, 1); assert.equal(result.stats.newsSelected, 1);
});

test('a changed publication date cannot revive a previously shared canonical article', async () => {
  const first = await collectDigest({sources:[rssSource],now,fetchImpl:fetchText(rss([{title:'Startup founders secure manufacturing investment',url:'https://example.org/shared'}]))});
  const legacyState = first.nextState;
  legacyState.seen[first.items[0].id].semanticHash = 'old-hash-that-included-a-publication-date';
  const repeat = await collectDigest({sources:[rssSource],state:legacyState,now:'2026-11-21T12:00:00Z',fetchImpl:fetchText(rss([{title:'Startup founders secure manufacturing investment',url:'https://example.org/shared?utm_source=new',date:'Sat, 21 Nov 2026 08:00:00 GMT'}]))});
  assert.equal(repeat.items.length,0); assert.equal(repeat.stats.alreadySeen,1);
});

test('rejects generic roundups and news older than 72 hours', async()=>{
  const result=await collectDigest({sources:[rssSource],now,fetchImpl:fetchText(rss([
    {title:'Weekly funding roundup for startup founders',url:'https://example.org/roundup'},
    {title:'Startup founders secure a manufacturing contract',url:'https://example.org/old',date:'Mon, 16 Nov 2026 08:00:00 GMT'}
  ]))});
  assert.equal(result.items.length,0); assert.equal(result.stats.stale,1); assert.equal(result.stats.irrelevant,1);
});

test('balances grants and events, six detailed opportunities, two news and distinct issuers',()=>{
  const opportunity=(index,category='grant')=>({id:`opportunity:${index}`,type:'opportunity',category,title:`Programme ${index}`,url:`https://issuer${index}.org/call`,applicationUrl:`https://issuer${index}.org/apply`,sourceType:'Official call page',sourceName:`Issuer ${index}`,eligibility:'Early stage founders',benefit:'Mentoring and competitive pilot support',financialConditions:'Selection is conditional',semanticHash:String(index),verifiedAt:now.toISOString()});
  const news=index=>({id:`url:${index}`,type:'news',title:`Startup ${['robotic warehouse robots expand overseas','new healthcare diagnostic funding platform','carbon capture hardware wins deployment'][index]}`,url:`https://news${index}.org/story`,sourceType:'RSS feed',sourceName:`News ${index}`,semanticHash:`news-${index}`,publishedAt:now.toISOString()});
  const candidates=[...Array.from({length:8},(_,i)=>opportunity(i)),opportunity(9,'event'),news(0),news(1),news(2)];
  const stats={duplicates:0,alreadySeen:0};
  const selected=selectDigestItems(candidates,{seen:{}},now,stats);
  assert.equal(selected.length,8); assert.equal(stats.opportunitiesSelected,6); assert.equal(stats.newsSelected,2);
  assert.ok(selected.some(item=>item.category==='event')); assert.ok(selected.some(item=>item.category==='grant'));
  assert.equal(new Set(selected.map(item=>new URL(item.url).hostname)).size,8);
});

test('near-identical syndicated headlines are suppressed across sites and prior editions',async()=>{
  assert.ok(similarHeadline('Startup Nova raises $8 million to expand electric mobility','Nova startup raises $8 million to expand electric mobility'));
  const sources=[rssSource,{...rssSource,id:'another',url:'https://another.org/feed'}];
  const fetchImpl=async url=>new Response(rss([{title:url.includes('another')?'Nova startup raises $8 million to expand electric mobility':'Startup Nova raises $8 million to expand electric mobility',url:url.includes('another')?'https://another.org/story':'https://example.org/story'}]));
  const first=await collectDigest({sources,now,fetchImpl});
  assert.equal(first.items.length,1);
  const second=await collectDigest({sources:[sources[1]],state:first.nextState,now,fetchImpl});
  assert.equal(second.items.length,0);
});

test('different reporting headlines about the same company funding event are deduplicated',()=>{
  assert.ok(similarHeadline('Data Security Startup Matters.AI Nets ₹115 Cr From Tanglin Venture Partners, Others','Enterprise data security startup Matters.AI raises Rs 115 Cr in pre-Series A round'));
  assert.equal(similarHeadline('Data Security Startup Matters.AI Nets ₹115 Cr','Enterprise data security startup Different.AI raises Rs 115 Cr'),false);
});

test('renaming a configured official call ID does not republish an unchanged call',()=>{
  const item={id:'opportunity:renamed',type:'opportunity',category:'grant',title:'Founder pilot grant',url:'https://issuer.org/call',applicationUrl:'https://issuer.org/apply',sourceType:'Official call page',semanticHash:'same-version'};
  const state={seen:{'call:legacy':{title:item.title,url:item.url,semanticHash:item.semanticHash}}};
  const stats={duplicates:0,alreadySeen:0};
  assert.equal(selectDigestItems([item],state,now,stats).length,0); assert.equal(stats.alreadySeen,1);
});

test('fresh supplementary news favors publishers not used in the recent digest',()=>{
  const make=(id,host,title)=>({id:`url:${id}`,type:'news',title,url:`https://${host}.org/${id}`,semanticHash:id,sourceType:'RSS feed',publishedAt:now.toISOString()});
  const state={seen:{'url:old':{url:'https://frequent.org/old',title:'Old founder compliance rule announcement',lastSeenAt:now.toISOString()}}};
  const items=[make('a','frequent','Startup launches a robot warehouse service'),make('b','newone','Founders gain access to a cloud infrastructure programme'),make('c','newtwo','New government procurement portal supports entrepreneurs')];
  const selected=selectDigestItems(items,state,now,{duplicates:0,alreadySeen:0});
  assert.deepEqual(selected.map(item=>item.id),['url:b','url:c']);
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
