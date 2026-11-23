import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { cleanText, parseDeadline } from './digest-text.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => cleanText(typeof value === 'string' ? value : String(value ?? ''));
const joined = value => asArray(value).map(text).filter(Boolean).join('; ');
const normalize = value => text(value).normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\s+([:;,])/g, '$1').trim();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const utcDate = value => new Date(value).toISOString().slice(0, 10);
const secretQuery = /^(?:access_token|token|password|passwd|secret|api[_-]?key|authorization|auth|session|sessionid)$/i;
const trackingQuery = /^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i;

export function safePublicUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new Error('Invalid public URL'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('Only public HTTPS URLs without credentials are allowed');
  if (isIP(hostname) || !hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)) throw new Error('Private, local or IP-literal destinations are not allowed');
  for (const key of url.searchParams.keys()) if (secretQuery.test(key)) throw new Error('Credential-bearing URLs are not allowed');
  if (/(?:access_token|password|secret|token)=/i.test(url.hash)) throw new Error('Credential-bearing URL fragments are not allowed');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (trackingQuery.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url;
}

function privateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a >= 224;
  }
  const ipv6 = address.toLowerCase();
  return ipv6 === '::' || ipv6 === '::1' || /^(?:fc|fd|fe[89ab]|ff)/.test(ipv6) || ipv6.startsWith('::ffff:');
}

async function verifyDns(url, fetchImpl) {
  // Injected fetch adapters must perform no live networking in tests. Production uses the native fetch.
  if (fetchImpl !== globalThis.fetch) return;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => privateAddress(record.address))) throw new Error('Source DNS resolves to a private or local address');
}

async function readBounded(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > MAX_BYTES) throw new Error('Source exceeds the 2 MB limit');
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('Source exceeds the 2 MB limit');
    return body;
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Source exceeds the 2 MB limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPublic(initial, allowedHosts, fetchImpl, { applicationOnly = false } = {}) {
  const controller = new AbortController(); let timer;
  const work = (async () => {
    let url = safePublicUrl(initial);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (!allowedHosts.has(url.hostname)) throw new Error('Redirect destination is outside the configured issuer/application hosts');
      await verifyDns(url, fetchImpl);
      const response = await fetchImpl(url.href, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'StartupOpportunityVerifier/1.0', Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location || redirects === MAX_REDIRECTS) throw new Error('Invalid or excessive source redirects');
        url = safePublicUrl(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url) {
        const final = safePublicUrl(response.url);
        if (!allowedHosts.has(final.hostname)) throw new Error('Response URL is outside the configured issuer/application hosts');
      }
      if (applicationOnly) { await response.body?.cancel?.(); return { url: url.href, httpStatus: response.status, body: null }; }
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (/application\/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(url.href)) { await response.body?.cancel?.(); throw new Error('PDF notice requires a supported text extractor; review instead of publishing'); }
      if (contentType && !/text\/|html|xml|json/i.test(contentType)) { await response.body?.cancel?.(); throw new Error('Unsupported issuer page content type'); }
      return { url: url.href, httpStatus: response.status, body: await readBounded(response) };
    }
    throw new Error('Source redirect limit exceeded');
  })();
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Source timed out after 15 seconds')); }, 15000); })]);
  } finally { clearTimeout(timer); }
}

export async function fetchVerifiedPage({ url, allowedHosts = [], fetchImpl = globalThis.fetch, applicationOnly = false } = {}) {
  const initial = safePublicUrl(url);
  const declaredHosts = allowedHosts instanceof Set ? [...allowedHosts] : asArray(allowedHosts);
  const hosts = new Set(declaredHosts.map(value => safePublicUrl(String(value).startsWith('https://') ? value : `https://${value}`).hostname));
  if (!hosts.size) hosts.add(initial.hostname);
  if (!hosts.has(initial.hostname)) throw new Error('Initial page is outside the configured issuer hosts');
  return fetchPublic(initial.href, hosts, fetchImpl, { applicationOnly });
}

export const normalizeEvidence = normalize;

function findLinkedUrls(html, base) {
  const safeHtml = html.replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)\s*>/gi, '');
  const links = new Set();
  for (const match of safeHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const linked = new URL(text(match[2]), base);
      // Older issuer links sometimes advertise HTTP; verify only their HTTPS equivalent.
      if (linked.protocol === 'http:' && !linked.port) linked.protocol = 'https:';
      links.add(safePublicUrl(linked.href).href);
    } catch { /* An unrelated unsafe link is never followed. */ }
  }
  return links;
}

function declaredDate(value, label) {
  if (!value) return null;
  const parsed = parseDeadline(value, 'UTC');
  if (!parsed) {
    if (/not (?:stated|disclosed|specified)|no fixed|rolling|throughout the year|cutoff not|closing date not|currently|live pass booking/i.test(value)) return null;
    if (label === 'Event date' && /\b20\d{2}\b/.test(value) && /January|February|March|April|May|June|July|August|September|October|November|December/i.test(value)) return null;
    throw new Error(`${label} needs an explicit valid day, month and year`);
  }
  return parsed.date;
}

function timezoneDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}`;
}

function validateTiming(seed, now) {
  const declaredStatus = normalize(seed.status).replace(/[_-]/g, ' ');
  if (declaredStatus === 'registration invited') throw new Error('Registration availability has not been confirmed');
  const status = declaredStatus === 'registration open' ? 'open' : declaredStatus;
  if (!['open', 'upcoming', 'rolling'].includes(status)) throw new Error('Only explicitly open, upcoming or rolling opportunities can be published');
  const deadlineDate = declaredDate(seed.deadline, 'Application/registration deadline');
  const eventDate = declaredDate(seed.eventEndDate ?? seed.eventDate, 'Event date');
  let deadlineISO = null;
  if (seed.deadlineISO && /^\d{4}-\d{2}-\d{2}$/.test(seed.deadlineISO)) {
    if (declaredDate(seed.deadlineISO, 'Deadline ISO date') !== deadlineDate) throw new Error('Deadline ISO date conflicts with the declared application/registration date');
    if (deadlineDate < utcDate(now)) return { expired: true, reason: 'Application/registration deadline has passed' };
  } else if (seed.deadlineISO) {
    const precise = new Date(seed.deadlineISO);
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(seed.deadlineISO) || !Number.isFinite(precise.getTime())) throw new Error('Precise deadline requires an explicit timezone offset');
    if (!deadlineDate) throw new Error('Precise deadline also requires the displayed application/registration date');
    const timeZone = seed.deadlineTimezone ?? seed.deadlineTimeZone;
    // Preserve the offset's local calendar date when an IANA timezone was not supplied.
    const preciseLocalDate = timeZone ? timezoneDate(precise, timeZone) : seed.deadlineISO.slice(0, 10);
    if (preciseLocalDate !== deadlineDate) throw new Error('Precise deadline conflicts with the declared application/registration date');
    deadlineISO = precise.toISOString();
    if (precise.getTime() <= now.getTime()) return { expired: true, reason: 'Application/registration deadline has passed' };
  } else if (deadlineDate && deadlineDate < utcDate(now)) return { expired: true, reason: 'Application/registration deadline has passed' };
  if (eventDate && eventDate < utcDate(now)) return { expired: true, reason: 'Event has already ended' };
  if (status === 'rolling' && deadlineDate) throw new Error('Rolling status conflicts with a fixed deadline');
  if (status === 'upcoming' && !eventDate && !deadlineDate) throw new Error('Upcoming status needs an explicit event or application date');
  return { status, deadlineDate, deadlineISO, expired: false };
}

function evidenceSnippets(seed) {
  return asArray(seed.requiredEvidence).map(value => typeof value === 'string' ? value : value?.text ?? value?.snippet ?? '').map(normalize).filter(Boolean);
}

function monetaryValues(value) {
  const values = new Set();
  const currencyMap = { '₹': 'INR', inr: 'INR', rs: 'INR', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP', 's$': 'SGD', sgd: 'SGD', 'us$': 'USD', '$': 'USD', usd: 'USD' };
  const units = 'crores?|cr\\.?|lakhs?|lacs?|million|billion|thousand|k\\b|m\\b';
  const prefix = new RegExp(`(?<![A-Za-z])([₹€£]|S\\$|US\\$|\\$|INR|EUR|GBP|SGD|USD|Rs\\.?)\\s*([\\d,]+(?:\\.\\d+)?)\\s*(${units})?`, 'gi');
  const suffix = new RegExp(`(?<![A-Za-z0-9])([\\d,]+(?:\\.\\d+)?)\\s*(${units})?\\s*([€£₹]|EUR|GBP|INR|SGD|USD)`, 'gi');
  const matches = [...text(value).matchAll(prefix)].map(match => [match[1], match[2], match[3]]);
  matches.push(...[...text(value).matchAll(suffix)].map(match => [match[3], match[1], match[2]]));
  for (const [symbol, number, unitText] of matches) {
    const currency = currencyMap[symbol.toLowerCase().replace(/\.$/, '')] ?? symbol;
    const unit = (unitText ?? '').toLowerCase();
    const multiplier = /^(?:crore|cr)/.test(unit) ? 1e7 : /^(?:lakh|lac)/.test(unit) ? 1e5 : /^(?:million|m$)/.test(unit) ? 1e6 : /^billion/.test(unit) ? 1e9 : /^(?:thousand|k$)/.test(unit) ? 1e3 : 1;
    const numeric = unit && /^\d+,\d{1,2}$/.test(number) ? number.replace(',', '.') : number.replace(/,/g, '');
    values.add(`${currency}:${Number(numeric) * multiplier}`);
  }
  return values;
}

function materialFacts(seed) {
  return { programme: normalize(seed.programme), organizer: normalize(seed.organizer), category: normalize(seed.category), summary: normalize(seed.summary ?? seed.description), eligibility: asArray(seed.eligibility).map(normalize), benefits: asArray(seed.benefits).map(normalize), financialConditions: asArray(seed.financialConditions).map(normalize), deadline: normalize(seed.deadline), deadlineISO: seed.deadlineISO ?? null, deadlineTimezone: seed.deadlineTimezone ?? seed.deadlineTimeZone ?? null, applicationPurpose: seed.applicationPurpose ?? null, deadlinePurpose: seed.deadlinePurpose ?? null, eventDate: normalize(seed.eventDate), eventEndDate: normalize(seed.eventEndDate), eventDatePurpose: seed.eventDatePurpose ?? null, eventLocation: normalize(seed.eventLocation), status: normalize(seed.status).replace(/[_-]/g, ' ') };
}

function previousEntry(previous, id, seedId) {
  const entries = previous?.seen ?? previous ?? {};
  return Object.hasOwn(entries, id) ? entries[id] : Object.hasOwn(entries, seedId) ? entries[seedId] : null;
}

export async function collectOpportunities({ seeds = [], now = new Date(), fetchImpl = globalThis.fetch, previous = {} } = {}) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid opportunity collection date');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  seeds = Array.isArray(seeds) ? seeds : seeds.seeds ?? seeds.opportunities ?? [];
  const items = []; const sourceChecks = []; const declaredIds = new Map(); const emittedIdentities = new Set();
  const duplicateDeclarations = new Map(); const conflictingIds = new Set();
  for (const seed of seeds) {
    if (!seed || typeof seed !== 'object' || !seed.id) continue;
    const fingerprint = hash(materialFacts(seed));
    if (duplicateDeclarations.has(String(seed.id)) && duplicateDeclarations.get(String(seed.id)) !== fingerprint) conflictingIds.add(String(seed.id));
    duplicateDeclarations.set(String(seed.id), fingerprint);
  }
  const checkTime = now.toISOString();
  // Shared issuer pages are fetched once per run, while every call retains its own evidence/timing check.
  const pageCache = new Map();
  for (const rawSeed of seeds) {
    const seed = rawSeed && typeof rawSeed === 'object' ? rawSeed : {};
    const check = { id: String(seed.id ?? ''), url: String(seed.sourceUrl ?? ''), checkedAt: checkTime, status: 'review', reason: null };
    sourceChecks.push(check);
    try {
      if (seed.enabled === false) { check.status = 'disabled'; continue; }
      if (!seed.id || !text(seed.programme) || !text(seed.organizer) || !text(seed.category)) throw new Error('Opportunity identity, programme, organizer and category are required');
      if (conflictingIds.has(String(seed.id))) throw new Error('Duplicate opportunity ID has conflicting material fields');
      const declaredHash = hash(materialFacts(seed));
      if (declaredIds.has(String(seed.id))) {
        if (declaredIds.get(String(seed.id)) !== declaredHash) throw new Error('Duplicate opportunity ID has conflicting material fields');
        check.status = 'duplicate'; check.reason = 'Duplicate opportunity seed'; continue;
      }
      declaredIds.set(String(seed.id), declaredHash);
      const timing = validateTiming(seed, now);
      if (timing.expired) { check.status = 'expired'; check.reason = timing.reason; continue; }
      const source = safePublicUrl(seed.sourceUrl);
      const application = seed.applicationUrl ? safePublicUrl(seed.applicationUrl, source) : null;
      const extraEvidence = asArray(seed.evidenceSources).map(entry => ({ ...entry, parsedUrl: safePublicUrl(entry.url ?? entry.sourceUrl) }));
      const allowedHosts = new Set([source.hostname, ...(application ? [application.hostname] : []), ...extraEvidence.map(entry => entry.parsedUrl.hostname), ...asArray(seed.allowedHosts).map(value => safePublicUrl(`https://${value}`).hostname)]);
      const cacheKey = `${source.href}|${[...allowedHosts].sort().join(',')}`;
      if (!pageCache.has(cacheKey)) pageCache.set(cacheKey, fetchPublic(source.href, allowedHosts, fetchImpl));
      const page = await pageCache.get(cacheKey);
      check.httpStatus = page.httpStatus; check.finalUrl = page.url;
      const pageText = normalize(page.body);
      const evidence = evidenceSnippets(seed);
      if (!evidence.length) throw new Error('A call must include explicit issuer evidence for its material fields');
      const missing = evidence.filter(snippet => !pageText.includes(snippet));
      if (missing.length) { check.missingEvidence = missing; throw new Error('Required issuer evidence is missing or changed; review current dates, amounts and terms'); }
      const verifiedPages = [page];
      check.evidenceSources = [];
      for (const extra of extraEvidence) {
        const extraKey = `${extra.parsedUrl.href}|${[...allowedHosts].sort().join(',')}`;
        if (!pageCache.has(extraKey)) pageCache.set(extraKey, fetchPublic(extra.parsedUrl.href, allowedHosts, fetchImpl));
        const extraPage = await pageCache.get(extraKey);
        const required = evidenceSnippets(extra);
        if (!required.length || required.some(snippet => !normalize(extraPage.body).includes(snippet))) throw new Error('Supplementary issuer evidence is missing or changed; review the material facts');
        verifiedPages.push(extraPage);
        check.evidenceSources.push({ url: extraPage.url, httpStatus: extraPage.httpStatus });
      }
      const verifiedText = verifiedPages.map(entry => normalize(entry.body)).join(' ');
      const sourceAmounts = monetaryValues(verifiedText);
      const declaredAmounts = monetaryValues(`${joined(seed.eligibility)} ${joined(seed.benefits)} ${joined(seed.financialConditions)}`);
      const missingAmounts = [...declaredAmounts].filter(amount => !sourceAmounts.has(amount));
      if (missingAmounts.length) { check.missingAmounts = missingAmounts; throw new Error('A declared monetary amount is not supported by the current checked issuer pages'); }
      if (timing.status === 'rolling' && !/\b(?:rolling|year[- ]round|throughout the year|no fixed deadline)\b/.test(pageText)) throw new Error('Rolling availability is not explicitly supported by the current issuer page');
      if (/\b(?:applications?|registrations?)\s+(?:are\s+)?(?:closed|cancelled|canceled)|\b(?:call|programme|program)\s+(?:is\s+)?(?:cancelled|canceled|withdrawn)\b/.test(pageText)) throw new Error('Issuer page includes closure/cancellation language; review the current call');
      if (!application) throw new Error('A verified application/registration URL is required for an actionable opportunity');
      if (application.href !== source.href) {
        const links = new Set(verifiedPages.flatMap(entry => [...findLinkedUrls(entry.body, entry.url)]));
        if (!links.has(application.href) && !verifiedText.includes(normalize(application.href))) throw new Error('Issuer page does not substantiate the configured application/registration link');
        const availability = await fetchPublic(application.href, allowedHosts, fetchImpl, { applicationOnly: true });
        check.applicationStatus = availability.httpStatus; check.applicationUrl = availability.url;
      } else { check.applicationStatus = page.httpStatus; check.applicationUrl = application.href; }
      const identity = hash([normalize(seed.parentProgramme ?? seed.programme), normalize(seed.organizer), application.href, timing.deadlineDate, normalize(seed.eventDate)]);
      if (emittedIdentities.has(identity)) { check.status = 'duplicate'; check.reason = 'Same programme and application round already selected'; continue; }
      emittedIdentities.add(identity);
      const isEvent = /(?:^|[_\s-])(?:event|conference|summit|webinar|workshop)(?:$|[_\s-])/i.test(seed.category);
      const item = { id: `opportunity:${seed.id}`, type: 'opportunity', category: text(seed.category), title: text(seed.programme), summary: joined(seed.summary ?? seed.description), eligibility: joined(seed.eligibility), benefit: joined(seed.benefits), financialConditions: joined(seed.financialConditions), applicationUrl: application.href, url: source.href, deadline: timing.status === 'rolling' ? 'Rolling applications — no fixed deadline' : text(seed.deadline) || null, deadlineDate: timing.deadlineDate, deadlineISO: timing.deadlineISO, deadlineTimeZone: seed.deadlineTimezone ?? seed.deadlineTimeZone ?? null, deadlineOriginalISO: timing.deadlineISO ? seed.deadlineISO : null, deadlinePurpose: seed.deadlinePurpose ?? (isEvent ? 'registration' : 'application'), eventDate: text(seed.eventDate) || null, eventDatePurpose: seed.eventDatePurpose ?? (isEvent ? 'event' : 'programme'), eventLocation: text(seed.eventLocation) || null, sourceName: text(seed.organizer), sourceType: 'Official call page', publishedAt: null, verifiedAt: checkTime, status: timing.status };
      item.applicationPurpose = seed.applicationPurpose ?? (isEvent ? 'registration' : 'application');
      item.semanticHash = hash({ ...materialFacts(seed), sourceUrl: source.href, applicationUrl: application.href });
      item.version = item.semanticHash;
      const old = previousEntry(previous, item.id, String(seed.id));
      check.semanticHash = item.semanticHash; check.verifiedAt = checkTime;
      if (old?.semanticHash === item.semanticHash || old === item.semanticHash) {
        const daysLeft = timing.deadlineDate ? (new Date(`${timing.deadlineDate}T23:59:59Z`) - now) / 86400000 : Infinity;
        const sinceShared = old?.lastSeenAt ? (now - new Date(old.lastSeenAt)) / 86400000 : 0;
        if (daysLeft > 0 && daysLeft <= 7 && sinceShared >= 7 && old?.reminderVersion !== item.semanticHash) {
          item.change = 'reminder'; check.status = 'deadline_reminder'; items.push(item); continue;
        }
        check.status = 'unchanged'; continue;
      }
      item.change = old ? 'updated' : 'new';
      check.status = 'verified'; items.push(item);
    } catch (error) { check.status = 'review'; check.reason = text(error.message).slice(0, 350); }
  }
  return { items, sourceChecks };
}

export function renderOpportunity(item) {
  const categoryNames = { grant: 'Grant', accelerator: 'Accelerator', fellowship: 'Fellowship', event: 'Founder event', challenge: 'Challenge', incubation_grant: 'Incubation & grant', recognition_network: 'Recognition & network' };
  const category = categoryNames[item.category] ?? text(item.category ?? 'Opportunity').replace(/_/g, ' ');
  const isEvent = item.deadlinePurpose === 'registration' || !item.deadlinePurpose && /(?:^|[_\s-])(?:event|conference|summit|webinar|workshop)(?:$|[_\s-])/i.test(item.category ?? '');
  const lines = [`*${category}: ${text(item.title)}*`];
  if (item.change === 'updated') lines.push('Updated opportunity details');
  if (item.change === 'reminder') lines.push('Deadline reminder — previously shared opportunity');
  if (item.summary) lines.push(text(item.summary));
  lines.push(`Who can apply: ${text(item.eligibility) || 'See the issuer’s eligibility criteria.'}`);
  lines.push(`Support: ${text(item.benefit) || 'Not specified in the verified notice.'}`);
  lines.push(`Important terms: ${text(item.financialConditions) || 'Funding, fees, equity and participation conditions are not disclosed in the checked summary; read the full notice.'}`);
  if (item.deadline) {
    let precise = '';
    if (!/\b\d{1,2}:\d{2}\b/.test(item.deadline)) {
      if (item.deadlineISO && item.deadlineTimeZone) precise = `, ${new Intl.DateTimeFormat('en-GB', { timeZone: item.deadlineTimeZone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(item.deadlineISO))}`;
      else if (item.deadlineOriginalISO) precise = `, ${item.deadlineOriginalISO.slice(11, 16)} ${item.deadlineOriginalISO.endsWith('Z') ? 'UTC' : `UTC${item.deadlineOriginalISO.slice(-6)}`}`;
    }
    lines.push(`${isEvent ? 'Registration deadline' : 'Application deadline'}: ${text(item.deadline)}${precise}`);
  } else lines.push(`${isEvent ? 'Registration deadline' : 'Application deadline'}: Not disclosed; check the issuer page.`);
  if (item.eventDate) lines.push(`${item.eventDatePurpose === 'event' || isEvent ? 'Event' : 'Programme dates'}: ${text(item.eventDate)}${item.eventLocation ? ` — ${text(item.eventLocation)}` : ''}`);
  if (item.applicationUrl) lines.push(`${item.applicationPurpose === 'expression_of_interest' ? 'Express interest' : isEvent ? 'Register' : 'Apply'}: ${item.applicationUrl}`);
  lines.push(`Issuer: ${text(item.sourceName)}`, `Source: ${item.url}`, `Checked: ${item.verifiedAt?.slice(0, 10) ?? 'Not recorded'}`);
  return lines.join('\n');
}
