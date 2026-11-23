import { cleanText, canonicalUrl, parseDeadline, localDate, datePattern } from './digest-text.mjs';
export { cleanText, canonicalUrl, parseDeadline } from './digest-text.mjs';
import { collectOpportunities, renderOpportunity } from './opportunities.mjs';
import { discoverOpportunities } from './discovery.mjs';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true, htmlEntities: true });
const relevant = /\b(start[ -]?ups?|founders?|entrepreneurs?|msmes?|incubation|incubators?|grants?|fellowships?|accelerators?|seed fund|paid pilots?|innovation challenge|hackathons?|bootcamps?|demo days?|pitch competitions?)\b/i;
const opportunitySignal = /\b(call for (applications|proposals)|applications? (?:are )?open|apply (?:now|by)|registrations? (?:are )?open|hackathons?|bootcamps?|demo days?|pitch competitions?|(?:grant|fellowship|incubation|accelerator|innovation challenge|paid pilot) (?:applications?|programme|program|opportunit(?:y|ies)|call|cohort))\b/i;
const excludedNews = /\b(passes? away|passed away|obituary|in memoriam|dies|died|horoscope|celebrity gossip)\b/i;
const roundup = /\b(roundups?|daily (?:digest|brief|wrap)|weekly (?:digest|wrap|funding)|funding (?:roundup|galore)|top (?:startup|funding) (?:news|stories)|this week|week in review)\b/i;
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const scalar = value => typeof value === 'object' && value !== null ? String(value['#text'] ?? value.__cdata ?? '') : String(value ?? '');
const digestHash = value => createHash('sha256').update(value).digest('hex');
const semanticText = value => cleanText(value).toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();

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
    const sourceSummary = cleanText(entry.description ?? entry.summary ?? entry.encoded ?? entry.content);
    const summary = sourceSummary.slice(0, 450);
    const publishedAt = new Date(scalar(entry.pubDate ?? entry.published ?? entry.date ?? entry.updated));
    const url = feedLink(entry, source.url);
    if (!url || !title || !Number.isFinite(publishedAt.getTime())) { stats.invalid++; continue; }
    if (publishedAt.getTime() > now.getTime()) { stats.future++; continue; }
    if (now.getTime() - publishedAt.getTime() > MAX_AGE_MS) { stats.stale++; continue; }
    if (!relevant.test(`${title} ${summary}`)) { stats.irrelevant++; continue; }
    const type = opportunitySignal.test(`${title} ${summary}`) ? 'opportunity' : 'news';
    if (type === 'news' && (excludedNews.test(title) || roundup.test(title))) { stats.irrelevant++; continue; }
    const explicitDeadline = type === 'opportunity' ? parseDeadline(findDeadline(`${title} ${sourceSummary}`)) : null;
    if (explicitDeadline && explicitDeadline.date < localDate(now, explicitDeadline.timeZone)) { stats.expiredCalls++; continue; }
    const item = { id: `url:${digestHash(url).slice(0, 24)}`, type, title, summary, url, publishedAt: publishedAt.toISOString(), sourceId: source.id, sourceName: source.name ?? source.id, sourceType: 'RSS feed', deadline: null };
    // A republished timestamp or edited excerpt never makes a shared article new.
    item.semanticHash = digestHash(url);
    result.push(item);
  }
  return result;
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
  if (item.applicationUrl) return renderOpportunity(item);
  const tag = item.type === 'opportunity' ? (item.sourceType === 'RSS feed' ? 'Opportunity announcement' : 'Opportunity / event') : 'Startup news';
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

export function similarHeadline(a, b) {
  const tokens = value => new Set(semanticText(value).split(' ').filter(token => token.length > 2 && !/^(?:the|and|for|with|from|its|has|that|this|startup|startups|founder|founders|news)$/.test(token)));
  const left = tokens(a), right = tokens(b);
  const funding = value => /\b(?:raises?|raised|nets?|secures?|bags?|funding)\b/i.test(value);
  const amounts = value => new Set([...cleanText(value).matchAll(/\b(\d+(?:[.,]\d+)?)\s*(crores?|cr|lakhs?|lacs?|million|mn|billion|bn)\b/gi)].map(match => `${match[1].replace(/,/g, '')}:${match[2].toLowerCase().replace(/^crores?$/, 'cr').replace(/^million$/, 'mn').replace(/^billion$/, 'bn')}`));
  const entities = value => new Set((cleanText(value).match(/\b[A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*\b/g) ?? []).map(word => word.toLowerCase()).filter(word => word.length >= 4 && !/^(?:startup|startups|enterprise|data|security|funding|round|series|raises|raised|nets|secures|bags|from|with|others|partners|venture|ventures|capital|india|indian|global|technology|fintech|healthtech|climate|energy|green|health|financial|platform)$/.test(word)));
  if (funding(a) && funding(b)) {
    const firstAmounts = amounts(a), secondAmounts = amounts(b), firstEntities = entities(a), secondEntities = entities(b);
    if ([...firstAmounts].some(amount => secondAmounts.has(amount)) && [...firstEntities].some(entity => secondEntities.has(entity))) return true;
  }
  if (Math.min(left.size, right.size) < 4) return semanticText(a) === semanticText(b);
  const overlap = [...left].filter(token => right.has(token)).length;
  return overlap / new Set([...left, ...right]).size >= 0.72 || overlap / Math.min(left.size, right.size) >= 0.9;
}

const issuerKey = item => new URL(item.url).hostname.replace(/^www\./, '');
const isRichOpportunity = item => item.type === 'opportunity' && item.sourceType !== 'RSS feed';

export function selectDigestItems(candidates, state, now, stats) {
  const chosen = [], ids = new Set(), urls = new Set(), issuers = new Map();
  const history = Object.entries(state.seen ?? {});
  const sharedUrls = new Set(history.filter(([id, item]) => id.startsWith('url:') || item.type === 'news' || item.sourceType === 'RSS feed').map(([, item]) => canonicalUrl(item.url)).filter(Boolean));
  const recentNews = history.filter(([id, item]) => (id.startsWith('url:') || item.sourceType === 'RSS feed') && now - new Date(item.lastSeenAt) <= 30 * 86400000).map(([, item]) => item.title);
  let characters = 120, opportunities = 0, news = 0;
  const pending = [];
  for (const item of candidates) {
    const rich = isRichOpportunity(item);
    const key = rich ? `${item.applicationUrl ?? item.url}|${semanticText(item.title)}` : item.url;
    if (ids.has(item.id) || urls.has(key) || (!rich && pending.some(other => !isRichOpportunity(other) && similarHeadline(item.title, other.title)))) { stats.duplicates++; continue; }
    ids.add(item.id); urls.add(key);
    const previous = state.seen?.[item.id] ?? (rich ? history.find(([, prior]) => canonicalUrl(prior.url) === item.url && semanticText(prior.title) === semanticText(item.title))?.[1] : null);
    if ((!rich && (sharedUrls.has(item.url) || recentNews.some(title => similarHeadline(item.title, title)))) || previous?.semanticHash === item.semanticHash && item.change !== 'reminder') { stats.alreadySeen++; continue; }
    item.change = item.change === 'reminder' ? 'reminder' : previous ? 'updated' : 'new'; item.version = item.semanticHash;
    pending.push(item);
  }
  const official = pending.filter(isRichOpportunity);
  // Reserve one place each for an available event and grant, then fill by deadline.
  const priority = official.sort((a, b) => (a.deadlineDate ?? '9999').localeCompare(b.deadlineDate ?? '9999') || a.id.localeCompare(b.id));
  const order = [...priority.filter(item => /event|summit|webinar|conference|workshop/.test(item.category ?? '')).slice(0, 1), ...priority.filter(item => /grant/.test(item.category ?? '')).slice(0, 1), ...priority];
  function add(item, issuerLimit) {
    if (chosen.includes(item)) return;
    const rich = isRichOpportunity(item), issuer = issuerKey(item);
    if ((issuers.get(issuer) ?? 0) >= issuerLimit || (rich ? opportunities >= 6 : news >= 2)) return;
    const rendered = itemText(item);
    if (characters + rendered.length + 3 > 9900) return;
    chosen.push(item); issuers.set(issuer, (issuers.get(issuer) ?? 0) + 1); characters += rendered.length + 3;
    if (rich) opportunities++; else news++;
  }
  for (const item of order) add(item, 1);
  for (const item of order) add(item, 2);
  const lastPublisherUse = new Map();
  for (const [id, prior] of history) {
    if (!(id.startsWith('url:') || prior.sourceType === 'RSS feed') || !canonicalUrl(prior.url)) continue;
    const publisher = issuerKey(prior), used = new Date(prior.lastSeenAt).getTime() || 0;
    lastPublisherUse.set(publisher, Math.max(lastPublisherUse.get(publisher) ?? 0, used));
  }
  const newsOrder = pending.filter(item => !isRichOpportunity(item)).sort((a,b) => (lastPublisherUse.get(issuerKey(a)) ?? 0) - (lastPublisherUse.get(issuerKey(b)) ?? 0) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  for (const item of newsOrder) add(item, 1);
  stats.opportunitiesSelected = opportunities; stats.newsSelected = news;
  return chosen;
}

export async function collectDigest({ sources = [], seeds = [], discoverySources = [], state = {}, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection date');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  sources = Array.isArray(sources) ? sources : sources.sources ?? [];
  const nextState = structuredClone(state);
  nextState.schemaVersion = 1; nextState.sources ??= {}; nextState.seen ??= {};
  const stats = { sourcesChecked: 0, sourcesFailed: 0, feedItems: 0, stale: 0, future: 0, irrelevant: 0, invalid: 0, expiredCalls: 0, pageReview: 0, duplicates: 0, alreadySeen: 0, itemsSelected: 0 };
  const candidates = [];
  if ((Array.isArray(discoverySources) ? discoverySources : discoverySources.sources ?? []).length) {
    const discovery = await discoverOpportunities({ sources: discoverySources, now, fetchImpl, previous: state });
    const researched = Array.isArray(seeds) ? seeds : seeds.opportunities ?? seeds.seeds ?? [];
    const coveredPages = new Set(researched.map(seed => canonicalUrl(seed.sourceUrl)).filter(Boolean));
    // A newly discovered representation of a researched call must not get a second identity.
    seeds = [...researched, ...discovery.seeds.filter(seed => !coveredPages.has(canonicalUrl(seed.sourceUrl)))];
    stats.discoveryCandidates = discovery.seeds.length;
    for (const check of discovery.sourceChecks) {
      const key = `discovery:${check.id}`, old = nextState.sources[key] ?? {};
      nextState.sources[key] = {...old, ...check, lastCheckedAt:check.checkedAt, lastSuccessfulCheckAt:['verified','unchanged'].includes(check.status) ? now.toISOString() : old.lastSuccessfulCheckAt ?? null};
    }
  }
  const official = await collectOpportunities({ seeds, now, fetchImpl, previous: state });
  candidates.push(...official.items);
  stats.officialVerified = official.items.length;
  stats.opportunityChecks = official.sourceChecks.length;
  stats.officialReview = official.sourceChecks.filter(check => check.status === 'review').length;
  stats.expiredCalls += official.sourceChecks.filter(check => check.status === 'expired').length;
  for (const check of official.sourceChecks) {
    const key = `opportunity:${check.id}`, old = nextState.sources[key] ?? {};
    nextState.sources[key] = {...old, ...check, lastCheckedAt:check.checkedAt, lastSuccessfulCheckAt:['verified','unchanged','deadline_reminder'].includes(check.status) ? now.toISOString() : old.lastSuccessfulCheckAt ?? null};
  }
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
  const selected = selectDigestItems(candidates, nextState, now, stats);
  for (const item of selected) nextState.seen[item.id] = { ...nextState.seen[item.id], semanticHash: item.semanticHash, lastSeenAt: now.toISOString(), publishedAt: item.publishedAt, title: item.title, url: item.url, applicationUrl: item.applicationUrl, type: item.type, category: item.category, sourceType: item.sourceType, ...(item.change === 'reminder' ? {reminderVersion: item.semanticHash, reminderSentAt: now.toISOString()} : {}) };
  stats.itemsSelected = selected.length;
  nextState.lastCollectedAt = now.toISOString();
  const sections = [];
  const detailed = selected.filter(isRichOpportunity), news = selected.filter(item => !isRichOpportunity(item));
  if (detailed.length) sections.push(`*Grants, programmes & events*\n\n${detailed.map(itemText).join('\n\n')}`);
  if (news.length) sections.push(`*Startup news & announcements*\n\n${news.map(itemText).join('\n\n')}`);
  const text = selected.length ? `*Startup opportunities & news — ${localDate(now)}*\n\n${sections.join('\n\n')}` : '';
  return { text, items: selected, nextState, stats };
}

async function cli() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const folder = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.resolve(process.env.DATA_DIR ?? value('--data-dir') ?? path.join(folder, 'data'));
  const sources = JSON.parse(await readFile(path.resolve(value('--sources') ?? path.join(folder, 'sources.json')), 'utf8'));
  const seeds = JSON.parse(await readFile(path.resolve(value('--seeds') ?? path.join(folder, 'opportunity-seeds.json')), 'utf8'));
  const discoverySources = JSON.parse(await readFile(path.resolve(value('--discovery-sources') ?? path.join(folder, 'discovery-sources.json')), 'utf8'));
  let state = {};
  try { state = JSON.parse(await readFile(path.join(dataDir, 'seen.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const now = value('--now') ? new Date(value('--now')) : new Date();
  const result = await collectDigest({ sources, seeds, discoverySources, state, now });
  await mkdir(path.join(dataDir, 'research'), { recursive: true });
  await mkdir(path.join(dataDir, 'outbox'), { recursive: true });
  const digestId = `startup-digest-${localDate(now)}`;
  await writeFile(path.join(dataDir, 'research', 'collector-result.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(dataDir, 'research', 'candidate-state.json'), JSON.stringify(result.nextState, null, 2));
  await writeFile(path.join(dataDir, 'outbox', `${digestId}.json`), JSON.stringify({ digestId, text: result.text }, null, 2));
  console.log(JSON.stringify({ dryRun: true, sending: false, digestId, dataDir, stats: result.stats }));
  // Collection never sends or commits seen.json. The publishing worker commits after acceptance.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
