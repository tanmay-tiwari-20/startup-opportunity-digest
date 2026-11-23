import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { fetchVerifiedPage, safePublicUrl, normalizeEvidence } from './opportunities.mjs';
import { cleanText, parseDeadline } from './digest-text.mjs';

const MAX_DETAILS = 20;
const PARALLEL = 2;
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => cleanText(typeof value === 'string' ? value : String(value ?? ''));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const usefulLink = /application|apply|program(?:me)?|incubat|accelerat|fellowship|grant|startup|challenge|innovation|call|event|summit|bootcamp|workshop|drone/i;
const unhelpfulPath = /(?:^|\/)(?:about(?:-us)?|contact(?:-us)?|privacy|terms|login|sign-in|careers|news|blog|programs?|events?|for-incubators|team|mentors|partners|partnerships)(?:\.html?)?\/?$/i;
const closedText = /\b(?:closed now|applications?\s+(?:are\s+)?(?:closed|cancelled|canceled)|registrations?\s+(?:are\s+)?closed|applications? coming soon)\b/i;
const openText = /applications?\s+(?:(?:are|is)\s+)?(?:now\s+)?open|registrations?\s+(?:(?:are|is)\s+)?(?:now\s+)?open|apply\s+now|register\s+now|submit\s+your\s+application(?:\s+here)?|passes\s+now\s+available|enroll\s+today|applications?\s+accepted\s+(?:on\s+a\s+)?rolling\s+basis/i;
const rollingText = /\brolling\b|\byear[- ]round\b|\bthroughout the year\b/i;
const MONTH_PATTERN = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_PATTERN = `(?:20\\d{2}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]20\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}\\s*,?\\s*20\\d{2}|${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*,?\\s*20\\d{2})`;

function parsedDate(value) {
  const months = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December' };
  const expanded = text(value).replace(/(\d{1,2})(ST|ND|RD|TH)\b/g, (_, day, ordinal) => `${day}${ordinal.toLowerCase()}`)
    .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?(?=\s|20\d{2}\b|,|$)/gi, match => months[match.replace(/\.$/, '').toLowerCase()])
    .replace(/(January|February|March|April|May|June|July|August|September|October|November|December)\s*(?=20\d{2})/gi, '$1 ');
  return parseDeadline(expanded, 'UTC');
}

function parsedPage(html) {
  const $ = load(html);
  const structured = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    const raw = $(node).text();
    if (raw.length > 256000 || structured.length >= 20) return;
    try {
      const parsed = JSON.parse(raw);
      const queue = asArray(parsed);
      while (queue.length && structured.length < 20) {
        const value = queue.shift();
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        if (value['@graph']) queue.push(...asArray(value['@graph']));
        if (asArray(value['@type']).some(type => /(?:^|\/)Event$/i.test(type))) structured.push(value);
      }
    } catch { /* Malformed JSON-LD is data to ignore, never code to run. */ }
  });
  $('script,style,noscript,nav,header,footer,form,[role="navigation"],.modal,.elementor-popup-modal,[aria-hidden="true"]').remove();
  const main = $('main').first();
  const root = main.length && main.find('h1').length ? main : $('body');
  const records = [];
  root.find('h1,h2,h3,h4,h5,p,li').each((_, node) => {
    const value = text($(node).text());
    if (!value || value.length > 2000) return;
    if (records.some(record => record.text === value && record.tag === node.tagName)) return;
    records.push({ tag: node.tagName.toLowerCase(), text: value });
  });
  return { $, root, records, structured, bodyText: text(root.text()) };
}

function section(records, pattern, max = 8) {
  const index = records.findIndex(record => /^h[1-5]$/.test(record.tag) && pattern.test(record.text));
  if (index < 0) return [];
  const level = Number(records[index].tag.slice(1));
  const result = [];
  for (const record of records.slice(index + 1)) {
    if (/^h[1-5]$/.test(record.tag) && Number(record.tag.slice(1)) <= level) break;
    if (record.text.length > 650 || /program impact|grants awarded|funds raised/i.test(record.text)) continue;
    result.push(record.text);
    if (result.length >= max) break;
  }
  return result;
}

function extractClosingDate(records, event = false) {
  const label = event ? '(?:registration(?:s)?\\s+(?:close|end)|register\\s+by|booking\\s+deadline|registration\\s+(?:closing\\s+)?date)' : '(?:applications?\\s+(?:close|end)|apply\\s+by|last\\s+date(?:\\s+(?:to|for)[^.:]{0,45})?|(?:closing|end|submission)\\s+date|deadline)';
  const regexp = new RegExp(`${label}(?:s)?(?:\\s+(?:on|is|to|till|until))?[^A-Za-z0-9]{0,15}(${DATE_PATTERN})`, 'i');
  for (const record of records) {
    const match = record.text.match(regexp);
    if (!match) continue;
    const parsed = parsedDate(match[1]);
    if (parsed) return { display: match[1], date: parsed.date, evidence: record.text };
  }
  return null;
}

function allowedApplicationLinks(page, source, pageUrl) {
  const host = safePublicUrl(pageUrl).hostname;
  const approved = new Set([host, ...asArray(source.applicationHosts).map(value => safePublicUrl(`https://${value}`).hostname)]);
  const links = new Map();
  page.root.find('a[href]').each((_, node) => {
    const label = text(page.$(node).text());
    const href = page.$(node).attr('href');
    if (!/apply|application|register|registration|enroll|book|passes|tickets/i.test(label)) return;
    try {
      const url = safePublicUrl(href, pageUrl);
      if (approved.has(url.hostname) && !unhelpfulPath.test(url.pathname)) links.set(url.href, { url: url.href, evidence: label });
    } catch { /* Untrusted/unapproved application destinations are not followed or emitted. */ }
  });
  return [...links.values()];
}

function programmeSeed(page, source, pageUrl, now) {
  const title = page.records.find(record => record.tag === 'h1')?.text;
  if (!title || /^(?:programs?|programmes?|events?|news|home|opportunities|startup|startups|contact us)$/i.test(title)) return { reason: 'Broad landing page rather than a programme detail' };
  if (!usefulLink.test(`${title} ${pageUrl}`)) return { reason: 'Page is not a founder programme, grant or event' };
  if (closedText.test(page.bodyText)) return { reason: 'Page includes closed/coming-soon application language' };
  const availabilityRecord = page.records.find(record => openText.test(record.text));
  const applicationLinks = allowedApplicationLinks(page, source, pageUrl);
  const availability = availabilityRecord?.text ?? applicationLinks.find(link => openText.test(link.evidence))?.evidence;
  if (!availability || !applicationLinks.length) return { reason: 'No explicit current application availability and approved application link' };
  if (applicationLinks.length > 1) return { reason: 'Multiple application routes are ambiguous; requires issuer review' };
  const closing = extractClosingDate(page.records);
  if (!closing && page.records.some(record => /\b(?:last\s+date|closing\s+date|applications?\s+close|deadline)\b/i.test(record.text) && /\b20\d{2}\b/.test(record.text))) return { reason: 'A closing date is present but cannot be parsed without guessing' };
  if (closing && closing.date < now.toISOString().slice(0, 10)) return { expired: true, reason: 'Discovered application deadline has passed' };
  let eligibility = section(page.records, /eligibility|who (?:can|should|is eligible)|criteria|requirements/i);
  if (!eligibility.length) eligibility = page.records.filter(record => record.tag === 'p' && record.text.length >= 20 && record.text.length <= 900 && !record.text.endsWith('?') && /\b(?:eligible|eligibility|must|required|can apply|we accept applications|full[- ]time|registered)\b/i.test(record.text) && /\b(?:startups?|ventures?|founders?|applicants?|enterprises?)\b/i.test(record.text)).slice(0, 4).map(record => record.text);
  const benefits = section(page.records, /program(?:me)? highlights|benefits|what (?:you|we)|offerings|funding.*support|support.*funding/i);
  const grantRecord = page.records.find(record => record.tag === 'p' && /(?:select|selected|may receive|can receive|will receive|opportunit)/i.test(record.text) && /(?:₹|Rs\.?|INR|EUR|\$|€).{0,30}\d/i.test(record.text) && /grant|funding|financial support/i.test(record.text));
  if (grantRecord && !benefits.includes(grantRecord.text)) benefits.push(grantRecord.text);
  const financial = page.records.filter(record => record.tag === 'p' && !record.text.endsWith('?') && /\b(?:no|not|does not|free|subject to|conditional|select|selected)\b.{0,70}\b(?:equity|fees?|charges?|grants?|funding|repayment)\b|\b(?:equity|fees?|costs?|repayment)\b.{0,70}\b(?:no|not|free|subject|conditional)\b/i.test(record.text)).slice(0, 3).map(record => record.text);
  const rolling = rollingText.test(availability);
  const formInstruction = /^\s*\*?\s*(?:note\b|this form\b|submit\b|apply\b|please\b|express\b|by submitting\b)|only (?:to )?(?:express|register).{0,25}interest|email address|contact number|privacy policy/i;
  const intro = page.records.find(record => record.tag === 'p' && record.text.length >= 70 && record.text.length <= 450 && !openText.test(record.text) && !formInstruction.test(record.text))?.text.replace(/\*/g, '') ?? '';
  const interestEvidence = page.records.find(record => /(?:form|submission).{0,45}(?:only|express).{0,35}interest|expression of interest/i.test(record.text))?.text;
  const category = /grant|financial support/i.test(`${title} ${benefits.join(' ')}`) ? /incubat/i.test(title) ? 'incubation_grant' : 'grant' : /fellowship|entrepreneur in residence/i.test(title) ? 'fellowship' : /accelerat/i.test(title) ? 'accelerator' : /incubat/i.test(title) ? 'incubation' : 'programme';
  const evidence = [...new Set([title, availability, ...eligibility, ...benefits, ...financial, ...(closing ? [closing.evidence] : []), ...(interestEvidence ? [interestEvidence] : [])])];
  return { seed: {
    id: `discovered-${fingerprint(pageUrl).slice(0, 20)}`, programme: title, organizer: source.name ?? source.id, category,
    sourceUrl: pageUrl, applicationUrl: applicationLinks[0].url, applicationPurpose: interestEvidence ? 'expression_of_interest' : 'application', eligibility: eligibility.length ? eligibility : null, benefits: benefits.length ? benefits : null,
    financialConditions: financial.length ? financial : null, summary: intro || null, deadline: rolling ? 'Rolling applications; no fixed closing date disclosed.' : closing?.display ?? 'Closing date not disclosed on the readable issuer page; applications currently invited.',
    deadlineISO: null, deadlineTimezone: null, deadlinePurpose: 'application', eventDate: null, eventLocation: null, status: rolling ? 'rolling' : 'open', requiredEvidence: evidence,
    verifiedDate: now.toISOString().slice(0, 10), discoverySource: source.url, evidenceNote: 'Discovered from an allowlisted official issuer directory; literal readable text only. Full issuer criteria and conditions apply.'
  } };
}

function visibleDateEvidence(records, isoDate) {
  for (const record of records) {
    const parsed = parsedDate(record.text);
    if (parsed?.date === isoDate) return record.text;
  }
  return null;
}

function eventSeeds(page, source, pageUrl, now) {
  const result = [];
  const approved = new Set([safePublicUrl(pageUrl).hostname, ...asArray(source.applicationHosts).map(value => safePublicUrl(`https://${value}`).hostname)]);
  for (const event of page.structured) {
    const title = text(event.name);
    if (!title || !/startup|founder|entrepreneur|innovation|business|pitch|hackathon|venture|technology|incubat/i.test(`${title} ${text(event.description)}`)) continue;
    const startDate = parseDeadline(String(event.startDate ?? ''), 'UTC')?.date;
    const endDate = parseDeadline(String(event.endDate ?? event.startDate ?? ''), 'UTC')?.date;
    if (!startDate || !endDate || endDate < startDate) { result.push({ reason: 'JSON-LD event has invalid or missing dates' }); continue; }
    if (endDate < now.toISOString().slice(0, 10)) { result.push({ expired: true, reason: 'JSON-LD event has ended' }); continue; }
    if (/Cancelled|Postponed|Rescheduled/i.test(String(event.eventStatus ?? ''))) { result.push({ reason: 'Event status is cancelled, postponed or rescheduled' }); continue; }
    if (!normalizeEvidence(page.bodyText).includes(normalizeEvidence(title))) { result.push({ reason: 'Event title is not substantiated by the readable issuer page' }); continue; }
    let offerUrl = null;
    for (const offer of asArray(event.offers)) {
      if (/SoldOut|Discontinued|OutOfStock/i.test(String(offer?.availability ?? ''))) continue;
      try { const candidate = safePublicUrl(offer?.url, pageUrl); if (approved.has(candidate.hostname)) { offerUrl = candidate.href; break; } } catch { /* No guessed booking link. */ }
    }
    const linked = allowedApplicationLinks(page, source, pageUrl);
    const applicationUrl = offerUrl ?? (linked.length === 1 ? linked[0].url : null);
    const availability = page.records.find(record => openText.test(record.text))?.text ?? linked.find(link => openText.test(link.evidence))?.evidence;
    if (!applicationUrl || !availability) { result.push({ reason: 'Event lacks a readable current registration invitation and approved booking route' }); continue; }
    const dateEvidence = visibleDateEvidence(page.records, startDate);
    if (!dateEvidence) { result.push({ reason: 'Event date is not substantiated in readable issuer text' }); continue; }
    const closing = extractClosingDate(page.records, true);
    if (closing && closing.date < now.toISOString().slice(0, 10)) { result.push({ expired: true, reason: 'Event registration deadline has passed' }); continue; }
    const location = typeof event.location === 'string' ? text(event.location) : text(event.location?.name ?? event.location?.address?.addressLocality ?? '');
    const eligibility = section(page.records, /eligibility|who (?:can|should)|participants|audience/i);
    const benefits = section(page.records, /highlights|benefits|what to expect|agenda/i, 6);
    const financial = page.records.filter(record => record.tag === 'p' && /fees?|prices?|tickets?|free (?:entry|registration)|GST|does not guarantee funding/i.test(record.text)).slice(0, 3).map(record => record.text);
    const eventDisplay = startDate === endDate ? startDate : `${startDate}–${endDate}`;
    result.push({ seed: {
      id: `discovered-event-${fingerprint([pageUrl, title, startDate]).slice(0, 20)}`, programme: title, organizer: source.name ?? source.id, category: 'event',
      sourceUrl: pageUrl, applicationUrl, eligibility: eligibility.length ? eligibility : null, benefits: benefits.length ? benefits : null, financialConditions: financial.length ? financial : null,
      summary: null, deadline: closing?.display ?? 'Booking cutoff not disclosed on the readable issuer page; registration currently invited.', deadlineISO: null, deadlineTimezone: null, deadlinePurpose: 'registration',
      eventDate: eventDisplay, eventEndDate: endDate, eventDatePurpose: 'event', eventLocation: location || null, status: 'registration_open',
      requiredEvidence: [...new Set([title, availability, dateEvidence, ...eligibility, ...benefits, ...financial, ...(closing ? [closing.evidence] : [])])],
      verifiedDate: now.toISOString().slice(0, 10), discoverySource: source.url, evidenceNote: 'Event dates from current issuer JSON-LD and corroborating readable page text. No inferred price, eligibility or cutoff.'
    } });
  }
  return result;
}

function directoryLinks(html, source, base, now) {
  const $ = load(html); $('script,style,form,footer').remove();
  const host = safePublicUrl(base).hostname;
  const approved = new Set([host, ...asArray(source.allowedHosts).map(value => safePublicUrl(`https://${value}`).hostname)]);
  const candidates = new Map();
  const patterns = asArray(source.linkPatterns).map(value => new RegExp(value, 'i'));
  $('a[href]').each((_, node) => {
    const label = text($(node).text()); const href = $(node).attr('href');
    if (closedText.test(label) || !usefulLink.test(`${label} ${href}`)) return;
    const closing = extractClosingDate([{ tag: 'p', text: label }]);
    if (closing && closing.date < now.toISOString().slice(0, 10)) return;
    try {
      const url = safePublicUrl(href, base);
      if (!approved.has(url.hostname) || url.href === safePublicUrl(base).href || unhelpfulPath.test(url.pathname) || /\.(?:pdf|png|jpe?g|zip|docx?)(?:$|\?)/i.test(url.pathname)) return;
      if (patterns.length && !patterns.some(pattern => pattern.test(`${label} ${url.pathname}`))) return;
      const score = /apply|call|fellowship|grant|application/i.test(label) ? 3 : /incubat|program|accelerat|challenge/i.test(label) ? 2 : 1;
      if (!candidates.has(url.href)) candidates.set(url.href, { url: url.href, label, score });
    } catch { /* An unsafe/outside link is never followed. */ }
  });
  const metadata = parsedPage(html).structured;
  for (const event of metadata) {
    try {
      const url = safePublicUrl(event.url, base);
      if (approved.has(url.hostname) && url.href !== safePublicUrl(base).href && !unhelpfulPath.test(url.pathname)) candidates.set(url.href, { url: url.href, label: text(event.name), score: 3 });
    } catch { /* Missing/outside metadata URLs do not become network destinations. */ }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, Math.min(8, Math.max(1, Number(source.maxDetails) || 4)));
}

export async function discoverOpportunities({ sources = [], now = new Date(), fetchImpl = globalThis.fetch, previous = {} } = {}) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid discovery date');
  sources = Array.isArray(sources) ? sources : sources.sources ?? [];
  const seeds = []; const sourceChecks = []; const details = []; const queued = new Set(); const emitted = new Set();
  for (const source of sources.slice(0, 8)) {
    if (source.enabled === false) continue;
    const check = { id: source.id, url: source.url, stage: 'directory', checkedAt: now.toISOString(), status: 'review', reason: null };
    sourceChecks.push(check);
    try {
      const initial = safePublicUrl(source.url);
      const hosts = [initial.hostname, ...asArray(source.allowedHosts)];
      const page = await fetchVerifiedPage({ url: initial.href, allowedHosts: hosts, fetchImpl });
      const links = directoryLinks(page.body, source, page.url, now);
      check.status = 'verified'; check.httpStatus = page.httpStatus; check.candidateLinks = links.length;
      for (const link of links) {
        if (details.length >= MAX_DETAILS || queued.has(link.url)) continue;
        queued.add(link.url); details.push({ source, link, hosts });
      }
    } catch (error) { check.reason = text(error.message).slice(0, 300); }
  }
  async function visit({ source, link, hosts }) {
    const check = { id: `${source.id}:detail-${fingerprint(link.url).slice(0, 12)}`, url: link.url, stage: 'detail', checkedAt: now.toISOString(), status: 'review', reason: null };
    sourceChecks.push(check);
    try {
      const response = await fetchVerifiedPage({ url: link.url, allowedHosts: hosts, fetchImpl });
      const page = parsedPage(response.body);
      const events = eventSeeds(page, source, response.url, now);
      const results = events.length ? events : [programmeSeed(page, source, response.url, now)];
      const valid = results.filter(result => result.seed);
      if (!valid.length) { check.status = results.some(result => result.expired) ? 'expired' : 'review'; check.reason = results[0]?.reason ?? 'No verified opportunity on the detail page'; return; }
      check.status = 'verified'; check.httpStatus = response.httpStatus; check.programmes = valid.length;
      for (const { seed } of valid) {
        const identity = `${safePublicUrl(seed.sourceUrl).href}|${normalizeEvidence(seed.programme)}`;
        if (emitted.has(identity)) continue;
        emitted.add(identity);
        seed.discoveryHash = fingerprint({ ...seed, verifiedDate: undefined, evidenceNote: undefined });
        const prior = previous.discoveryHashes?.[seed.id] ?? previous.discovery?.[seed.id]?.discoveryHash;
        if (prior === seed.discoveryHash) { check.status = 'unchanged'; continue; }
        seeds.push(seed);
      }
    } catch (error) { check.reason = text(error.message).slice(0, 300); }
  }
  for (let offset = 0; offset < details.length; offset += PARALLEL) await Promise.all(details.slice(offset, offset + PARALLEL).map(visit));
  return { seeds, sourceChecks };
}
