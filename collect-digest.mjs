import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true, htmlEntities: true });
const relevant = /\b(start[ -]?ups?|founders?|entrepreneurs?|msmes?|incubation|incubators?|grants?|fellowships?|accelerators?|seed fund|paid pilots?|innovation challenge|hackathons?|bootcamps?|demo days?|pitch competitions?)\b/i;
const opportunitySignal = /\b(call for (applications|proposals)|applications? (?:are )?open|apply (?:now|by)|registrations? (?:are )?open|hackathons?|bootcamps?|demo days?|pitch competitions?|(?:grant|fellowship|incubation|accelerator|innovation challenge|paid pilot) (?:applications?|programme|program|opportunit(?:y|ies)|call|cohort))\b/i;
const excludedNews = /\b(passes? away|passed away|obituary|in memoriam|dies|died|horoscope|celebrity gossip)\b/i;
const tracking = /^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid)$/i;
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const scalar = value => typeof value === 'object' && value !== null ? String(value['#text'] ?? value.__cdata ?? '') : String(value ?? '');
const digestHash = value => createHash('sha256').update(value).digest('hex');
const semanticText = value => cleanText(value).toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();

export function cleanText(value) {
  let text = scalar(value).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(?:p|div|br|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };
  text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : ' ';
  });
  // A second tag pass catches entity-encoded markup without executing it.
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
}

export function canonicalUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function feedLink(entry, base) {
  for (const value of list(entry.link)) {
    const link = typeof value === 'object' ? value['@_href'] ?? scalar(value) : value;
    if (typeof value === 'object' && value['@_rel'] && value['@_rel'] !== 'alternate') continue;
    const result = canonicalUrl(link, base);
    if (result) return result;
  }
  const guid = scalar(entry.guid);
  return /https?:\/\//i.test(guid) ? canonicalUrl(guid, base) : null;
}

function extractFeed(xml, source, now, stats) {
  // No external entities or declarations are needed for a feed. Reject them entirely.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed contains a forbidden XML declaration');
  const doc = parser.parse(xml);
  const entries = list(doc.rss?.channel?.item ?? doc.feed?.entry ?? doc.RDF?.item);
  const result = [];
  for (const entry of entries) {
    stats.feedItems++;
    const title = cleanText(entry.title);
    const summary = cleanText(entry.description ?? entry.summary ?? entry.encoded ?? entry.content).slice(0, 250);
    const publishedAt = new Date(scalar(entry.pubDate ?? entry.published ?? entry.date ?? entry.updated));
    const url = feedLink(entry, source.url);
    if (!url || !title || !Number.isFinite(publishedAt.getTime())) { stats.invalid++; continue; }
    if (publishedAt.getTime() > now.getTime()) { stats.future++; continue; }
    if (now.getTime() - publishedAt.getTime() > MAX_AGE_MS) { stats.stale++; continue; }
    if (!relevant.test(`${title} ${summary}`)) { stats.irrelevant++; continue; }
    const type = opportunitySignal.test(`${title} ${summary}`) ? 'opportunity' : 'news';
    if (type === 'news' && excludedNews.test(title)) { stats.irrelevant++; continue; }
    const explicitDeadline = type === 'opportunity' ? parseDeadline(findDeadline(`${title} ${summary}`)) : null;
    if (explicitDeadline && explicitDeadline.date < localDate(now, explicitDeadline.timeZone)) { stats.expiredCalls++; continue; }
    const item = { id: `url:${digestHash(url).slice(0, 24)}`, type, title, summary, url, publishedAt: publishedAt.toISOString(), sourceId: source.id, sourceName: source.name ?? source.id, sourceType: 'RSS feed', deadline: null };
    // Feed article identity is the URL and original publication date; excerpt edits alone are not a new article.
    item.semanticHash = digestHash(JSON.stringify([url, semanticText(title), item.publishedAt]));
    result.push(item);
  }
  return result;
}

const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const datePattern = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s*,?\\s*\\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*,?\\s*\\d{4})';

export function parseDeadline(value, timeZone = 'Asia/Kolkata') {
  const text = cleanText(value);
  let year, month, day, match;
  if ((match = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/))) [, year, month, day] = match;
  else if ((match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/))) [, day, month, year] = match;
  else if ((match = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*,?\s*(20\d{2})\b/))) { [, day, month, year] = match; month = months[month.toLowerCase()]; }
  else if ((match = text.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b/))) { [, month, day, year] = match; month = months[month.toLowerCase()]; }
  year = Number(year); month = Number(month); day = Number(day);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Date-only notices have no claimed closing time. Compare calendar dates in the configured issuer timezone.
  return { date: isoDate, display: match[0], timeZone };
}

function localDate(now, timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

function findDeadline(scope, pattern) {
  if (pattern) {
    const match = scope.match(new RegExp(pattern, 'i'));
    return match ? match[1] ?? match[0] : null;
  }
  const match = scope.match(new RegExp(`(?:last\\s+date(?:\\s+(?:to|for)[^.:]{0,45})?|deadline|applications?\\s+(?:close|end)(?:s)?|apply\\s+by)(?:\\s+(?:on|is))?[^A-Za-z0-9]{0,12}(${datePattern})`, 'i'));
  return match?.[1] ?? null;
}

function extractPage(html, source, now, stats) {
  const text = cleanText(html);
  const declared = source.calls ?? source.options?.calls;
  let calls = list(declared);
  if (!calls.length && source.extractor === 'elevate') {
    calls = [
      { id: 'elevate-nxt', title: 'ELEVATE NxT', anchor: 'ELEVATE\\s+(?:NxT|NXT|Next)' },
      { id: 'elevate-minorities', title: 'ELEVATE Minorities', anchor: 'ELEVATE\\s+Minorit(?:y|ies)' }
    ];
  } else if (!calls.length && source.extractor === 'bevisioneers') {
    calls = [{ id: 'bevisioneers', title: 'beVisioneers: The Mercedes-Benz Fellowship', deadlinePattern: `applications?[^.]{0,100}?(?:close|deadline)(?:\\s+(?:on|is))?[^A-Za-z0-9]{0,12}(${datePattern})` }];
  }
  if (!calls.length) { stats.pageReview++; return []; }
  const result = [];
  for (const call of calls) {
    let scope = text;
    if (call.anchor) {
      const anchor = new RegExp(call.anchor, 'i').exec(text);
      if (!anchor) { stats.pageReview++; continue; }
      scope = text.slice(anchor.index, anchor.index + (call.scopeChars ?? 1800));
    }
    if (/\b(?:applications?|registrations?)\s+(?:are\s+)?(?:closed|cancelled|canceled)|\b(?:call|programme|program)\s+(?:is\s+)?(?:cancelled|canceled|withdrawn)\b/i.test(scope)) { stats.expiredCalls++; continue; }
    const deadlineRaw = findDeadline(scope, call.deadlinePattern ?? source.options?.deadlinePattern);
    const deadline = parseDeadline(deadlineRaw, call.timeZone ?? source.timeZone ?? 'Asia/Kolkata');
    if (!deadline) { stats.pageReview++; continue; }
    if (deadline.date < localDate(now, deadline.timeZone)) { stats.expiredCalls++; continue; }
    if (call.expectedDeadline && parseDeadline(call.expectedDeadline)?.date !== deadline.date) { stats.pageReview++; continue; }
    let deadlineISO = null;
    if (call.deadlineISO) {
      const preciseDeadline = new Date(call.deadlineISO);
      if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(call.deadlineISO) || !Number.isFinite(preciseDeadline.getTime()) || localDate(preciseDeadline, deadline.timeZone) !== deadline.date) { stats.pageReview++; continue; }
      if (preciseDeadline.getTime() <= now.getTime()) { stats.expiredCalls++; continue; }
      deadlineISO = preciseDeadline.toISOString();
    }
    if (call.requiredText && !new RegExp(call.requiredText, 'i').test(scope)) { stats.pageReview++; continue; }
    const url = canonicalUrl(call.url ?? source.url, source.url);
    if (!url || !call.title) { stats.pageReview++; continue; }
    // Configured factual fields must be accompanied by requiredText or a specific extraction pattern.
    const summary = cleanText(call.summary ?? '').slice(0, 250);
    const eligibility = cleanText(call.eligibility ?? '').slice(0, 250);
    const benefit = cleanText(call.benefit ?? '').slice(0, 250);
    const item = { id: `call:${source.id}:${call.id ?? digestHash(semanticText(call.title)).slice(0, 16)}`, type: 'opportunity', title: cleanText(call.title), summary, eligibility, benefit, url, deadline: deadline.display, deadlineDate: deadline.date, deadlineISO, deadlineTimeZone: call.timeZone ?? source.timeZone ?? null, publishedAt: null, verifiedAt: now.toISOString(), sourceId: source.id, sourceName: source.name ?? source.id, sourceType: 'Official call page' };
    item.semanticHash = digestHash(JSON.stringify([semanticText(item.title), item.deadlineDate, deadlineISO, semanticText(eligibility), semanticText(benefit), semanticText(summary), url]));
    result.push(item);
  }
  return result;
}

async function fetchBounded(url, fetchImpl) {
  const controller = new AbortController();
  let timer;
  const work = (async () => {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'StartupDigestCollector/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (declared > MAX_BYTES) throw new Error('Source exceeds 2 MB limit');
    if (!response.body?.getReader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Source exceeds 2 MB limit');
      return text;
    }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Source exceeds 2 MB limit'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  })();
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Source timed out after 15 seconds')); }, 15000); })]);
  } finally { clearTimeout(timer); }
}

function itemText(item) {
  const tag = item.type === 'opportunity' ? 'Opportunity / event' : 'Startup news';
  const lines = [`*${tag}: ${item.title}*`];
  if (item.change === 'updated') lines.push('Updated official call details.');
  if (item.summary) lines.push(item.summary);
  if (item.eligibility) lines.push(`Who: ${item.eligibility}`);
  if (item.benefit) lines.push(`Support: ${item.benefit}`);
  if (item.deadline) {
    const precise = item.deadlineISO ? new Intl.DateTimeFormat('en-GB', { timeZone: item.deadlineTimeZone ?? 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(item.deadlineISO)) : null;
    lines.push(`Deadline: ${item.deadline}${precise ? `, ${precise}` : ''}`);
  }
  if (item.publishedAt) lines.push(`Published: ${item.publishedAt.slice(0, 10)}`);
  if (item.type === 'opportunity' && item.sourceType === 'RSS feed') lines.push('Feed update: check the linked notice for eligibility, support terms and current dates.');
  else if (item.type === 'opportunity' && !item.eligibility && !item.benefit) lines.push('See the official notice for eligibility, support, costs and equity terms.');
  lines.push(`${item.sourceName} — ${item.sourceType}`, item.url);
  return lines.join('\n');
}

export async function collectDigest({ sources = [], state = {}, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection date');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  sources = Array.isArray(sources) ? sources : sources.sources ?? [];
  const nextState = structuredClone(state);
  nextState.schemaVersion = 1; nextState.sources ??= {}; nextState.seen ??= {};
  const stats = { sourcesChecked: 0, sourcesFailed: 0, feedItems: 0, stale: 0, future: 0, irrelevant: 0, invalid: 0, expiredCalls: 0, pageReview: 0, duplicates: 0, alreadySeen: 0, itemsSelected: 0 };
  const candidates = [];
  for (let offset = 0; offset < sources.length; offset += 3) {
    await Promise.all(sources.slice(offset, offset + 3).map(async (source, sourceOffset) => {
      if (source.enabled === false) return;
      const sourceId = source.id ?? `source-${offset + sourceOffset}`;
      const sourceRecord = nextState.sources[sourceId] ?? {};
      stats.sourcesChecked++;
      try {
        if (!canonicalUrl(source.url)) throw new Error('Invalid source URL');
        const raw = await fetchBounded(source.url, fetchImpl);
        const items = source.type === 'rss' ? extractFeed(raw, { ...source, id: sourceId }, now, stats) : extractPage(raw, { ...source, id: sourceId }, now, stats);
        candidates.push(...items);
        nextState.sources[sourceId] = { ...sourceRecord, url: source.url, lastCheckedAt: now.toISOString(), lastSuccessfulCheckAt: now.toISOString(), lastSeenPublicationAt: items.map(i => i.publishedAt).filter(Boolean).sort().at(-1) ?? sourceRecord.lastSeenPublicationAt ?? null, status: 'ok', error: null, extractedItems: items.length };
      } catch (error) {
        stats.sourcesFailed++;
        nextState.sources[sourceId] = { ...sourceRecord, url: source.url, lastCheckedAt: now.toISOString(), status: 'review', error: cleanText(error.message).slice(0, 300) };
      }
    }));
  }
  candidates.sort((a, b) => (a.type === b.type ? 0 : a.type === 'opportunity' ? -1 : 1) || (b.publishedAt ?? b.verifiedAt).localeCompare(a.publishedAt ?? a.verifiedAt) || a.id.localeCompare(b.id));
  const selected = []; const ids = new Set(); const urls = new Set();
  let charCount = 70;
  for (const item of candidates) {
    const duplicateKey = item.sourceType === 'RSS feed' ? item.url : `${item.url}|${semanticText(item.title)}`;
    if (ids.has(item.id) || urls.has(duplicateKey)) { stats.duplicates++; continue; }
    ids.add(item.id); urls.add(duplicateKey);
    const previous = nextState.seen[item.id];
    if (previous?.semanticHash === item.semanticHash) { stats.alreadySeen++; continue; }
    item.change = previous ? 'updated' : 'new';
    item.version = item.semanticHash;
    const rendered = itemText(item);
    if (selected.length >= 8 || charCount + rendered.length + 3 > 9900) continue;
    selected.push(item); charCount += rendered.length + 3;
    nextState.seen[item.id] = { semanticHash: item.semanticHash, lastSeenAt: now.toISOString(), publishedAt: item.publishedAt, title: item.title, url: item.url };
  }
  stats.itemsSelected = selected.length;
  nextState.lastCollectedAt = now.toISOString();
  const text = selected.length ? `*Startup digest — ${localDate(now)}*\n\n${selected.map(itemText).join('\n\n')}` : '';
  return { text, items: selected, nextState, stats };
}

async function cli() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const folder = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.resolve(process.env.DATA_DIR ?? value('--data-dir') ?? path.join(folder, 'data'));
  const sources = JSON.parse(await readFile(path.resolve(value('--sources') ?? path.join(folder, 'sources.json')), 'utf8'));
  let state = {};
  try { state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const now = value('--now') ? new Date(value('--now')) : new Date();
  const result = await collectDigest({ sources, state, now });
  await mkdir(path.join(dataDir, 'research'), { recursive: true });
  await mkdir(path.join(dataDir, 'outbox'), { recursive: true });
  const digestId = `startup-digest-${localDate(now)}`;
  await writeFile(path.join(dataDir, 'research', 'collector-result.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(dataDir, 'research', 'candidate-state.json'), JSON.stringify(result.nextState, null, 2));
  await writeFile(path.join(dataDir, 'outbox', `${digestId}.json`), JSON.stringify({ digestId, text: result.text }, null, 2));
  console.log(JSON.stringify({ dryRun: true, sending: false, digestId, dataDir, stats: result.stats }));
  // Collection never sends and never commits state.json. The publishing worker commits candidate state after acceptance.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
