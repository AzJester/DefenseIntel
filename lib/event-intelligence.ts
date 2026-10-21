/** Conservative, deterministic public-evidence grouping and transparent relevance rules. */
export type IntelligencePreferences = {
  agencies: string[]; programs: string[]; capabilities: string[]; companies: string[];
  minAwardValue: number; minimumScore: number;
};
type Evidence = {
  recordId: string; url: string; title: string; published: string; fetchedAt: string; source: string;
};
type Candidate = {
  id: string; title: string; summary: string; category: string; companies: string[];
  published: string; firstSeen: string; lastSeen: string; source: Evidence;
  rank: number; contractIds: string[]; amounts: number[]; tokens: string[]; normalized: string;
  parties: string[]; actions: string[]; officialFacts: Record<string, string | number | null> | null;
  text: string;
};
const DAY = 86400000;
const text = (value: any, maximum = 3000) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const cleanList = (value: any, maximum = 40): string[] => {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,;|]/) : [];
  const seen = new Set<string>();
  return input.map(v => text(v, 120)).filter(v => v && !seen.has(v.toLowerCase()) && !!seen.add(v.toLowerCase())).slice(0, maximum);
};
const number = (value: any): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const date = (value: any): string => {
  if (!value) return '';
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
};
const ordered = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const numeric = (values: number[]) => [...new Set(values.filter(v => Number.isFinite(v)))].sort((a, b) => a - b);
const lower = (value: string) => value.toLowerCase();

export function normalizePreferences(value: any): IntelligencePreferences {
  return {
    agencies: cleanList(value?.agencies), programs: cleanList(value?.programs),
    capabilities: cleanList(value?.capabilities), companies: cleanList(value?.companies),
    minAwardValue: Math.min(1e15, Math.max(0, number(value?.minAwardValue) ?? 0)),
    minimumScore: Math.min(100, Math.max(0, number(value?.minimumScore) ?? 25)),
  };
}

// A stable non-secret identifier. No network calls, changing clocks, or source ordering affect it.
function hash(value: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b ^ value.charCodeAt(i), 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bu\.?s\.?\s+cyber\s+command\b|\bcyber\s+command\b/g, ' cybercom ')
    .replace(/\bu\.?s\.?\b|\bunited states\b/g, ' us ')
    .replace(/\b(?:awarded|awards|secures|secured|wins|won|receives|received)\b/g, ' award ')
    .replace(/\b(?:partnership|partnerships|partners|partnering|teaming|teams)\b/g, ' partner ')
    .replace(/\$\s*(\d[\d,.]*)\s*(billion|million|thousand|bn|mn|b|m|k)\b/gi, (_match, amount, unit) => {
      const multiplier = /^(billion|bn|b)$/i.test(unit) ? 1e9 : /^(million|mn|m)$/i.test(unit) ? 1e6 : 1e3;
      return ` usd${Math.round(Number(amount.replace(/,/g, '')) * multiplier)} `;
    })
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const STOP = new Set('a an the and or of on to for from by with in at as its their new us inc corp corporation international company companies group announces announce announced latest strategic contract contracts award defense defence partner agreement support supporting will'.split(' '));
function titleTokens(title: string, companies: string[]): string[] {
  const companyWords = new Set(companies.flatMap(company => normalized(company).split(' ')));
  return ordered(normalized(title).split(' ').filter(token => token.length > 1 && !STOP.has(token) && !companyWords.has(token)));
}
function safeUrl(value: any): string {
  try {
    const result = new URL(String(value || ''));
    if (!['https:', 'http:'].includes(result.protocol) || result.username || result.password) return '';
    result.hash = '';
    for (const key of [...result.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) result.searchParams.delete(key);
    return result.toString();
  } catch { return ''; }
}
function normalizedContract(value: any): string {
  return text(value, 180).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function contractIds(record: any, rawText: string, official: boolean): string[] {
  const explicit = [record.contractId, record.contractNumber, record.piid, record.PIID];
  // USAspending's display award ID is the PIID. Its generated ID identifies an official award.
  if (official) explicit.push(record.awardId, record.generatedId, record.generated_internal_id);
  const found = rawText.match(/\b[A-Z0-9]{6}-?\d{2}-?[A-Z]-?[A-Z0-9]{4,6}\b/g) || [];
  return ordered([...explicit, ...found].filter(Boolean).map(normalizedContract).filter(v => v.length >= 6));
}
function monetaryValues(record: any, rawText: string): number[] {
  const values = [record.amount, record.obligations, record.totalObligated, record.ceiling, record.baseAndAllOptionsValue, record.awardValue]
    .map(number).filter((v): v is number => v !== null);
  for (const match of rawText.matchAll(/\$\s*(\d[\d,.]*)\s*(billion|million|thousand|bn|mn|b|m|k)?\b/gi)) {
    const value = Number(match[1].replace(/,/g, '')), unit = (match[2] || '').toLowerCase();
    const multiplier = /^(billion|bn|b)$/.test(unit) ? 1e9 : /^(million|mn|m)$/.test(unit) ? 1e6 : /^(thousand|k)$/.test(unit) ? 1e3 : 1;
    if (Number.isFinite(value)) values.push(Math.round(value * multiplier));
  }
  return numeric(values);
}
function parties(title: string): string[] {
  const result: string[] = [];
  const prefix = /^(.*?)\s+(?:(?:announce|announces|announced|expand|expands|form|forms|sign|signs)\s+)?(?:a\s+)?(?:partnership|partner(?:s|ing)?|team(?:s|ing)?\s+(?:up|with)|collaborat(?:es|e|ion))\b/i.exec(title)?.[1];
  if (prefix) result.push(...prefix.split(/\s+(?:and|with)\s+|\s*&\s*|,\s*/i));
  const after = /(?:partner(?:s|ing)?|team(?:s|ing)?|collaborat(?:es|e|ion))\s+(?:up\s+)?(?:with|and)\s+(.+?)(?:\s+(?:to|on|for|in|as|at|through)\b|[,:;]|$)/i.exec(title)?.[1];
  if (after) result.push(...after.split(/\s+and\s+|\s*&\s*|,\s*/i));
  return ordered(result.map(value => normalized(value.replace(/\b(?:announces?|expand[sd]?|forms?|signs?)\b/gi, ''))).filter(value => value && value.split(' ').length <= 6));
}
function actions(rawText: string, category: string): string[] {
  if (!contractCategory(category)) return [category];
  const result: string[] = [];
  if (/\b(?:modification|modified|amendment)\b/i.test(rawText)) result.push('modification');
  if (/\b(?:option(?:\s+year)?\s+(?:exercise|exercised)|exercis(?:e|ed|es)\s+(?:an?\s+)?option)\b/i.test(rawText)) result.push('option exercise');
  if (/\b(?:task|delivery)\s+order\b/i.test(rawText)) result.push('order');
  return result.length ? ordered(result) : [category === 'Contract award' ? 'award' : category === 'Contract modification' ? 'modification' : 'contract action'];
}
const contractCategory = (value: string) => ['Contract award', 'Contract action', 'Contract modification'].includes(value);
function category(record: any, official: boolean): string {
  const value = text(record.category, 80);
  if (/^contract action$/i.test(value)) return 'Contract action';
  if (/^contract modification$/i.test(value)) return 'Contract modification';
  if (/^(contract award|award)$/i.test(value)) return 'Contract award';
  // An official award snapshot may describe an old contract's latest action, not a new award.
  if (official) return 'Contract action';
  if (/^(teaming|partnership)$/i.test(value)) return 'Teaming';
  if (/^(acquisition|merger|m&a)$/i.test(value)) return 'Acquisition';
  return 'News';
}
function makeCandidate(record: any, official = false): Candidate | null {
  if (!record || record.origin === 'baseline') return null;
  const snapshot = official;
  official = official || /official award record/i.test(text(record.verification, 240));
  const companyNames = cleanList(record.companies?.length ? record.companies : record.company || record.matchedCompany || record.recipientName || record.recipient, 30);
  const title = text(record.title || record.description || (official ? `Contract ${record.awardId || record.contractId || ''}` : ''), 700);
  if (!title || !companyNames.length) return null;
  const summary = text(record.summary || record.description, 5000), sourceUrl = safeUrl(record.url || record.sourceUrl || record.awardUrl);
  const published = date(record.published || record.actionDate || record.latestActionDate || record.date || record.startDate);
  const fetchedAt = date(record.fetchedAt || record.retrievedAt || record.checkedAt);
  const firstSeen = date(record.firstSeen || record.created) || fetchedAt || published;
  const lastSeen = date(record.lastSeen || record.fetchedAt || record.retrievedAt || record.checkedAt || record.updatedAt) || firstSeen;
  const sourceName = text(record.source || (official ? 'USAspending official award record' : 'Public source'), 200);
  const publisher = text(record.publisher || sourceName.split(' · ').slice(1).join(' · '), 200);
  const publisherPattern = publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchingTitle = publisher ? title.replace(new RegExp(`\\s+(?:-|–|—|\\|)\\s+${publisherPattern}\\s*$`, 'i'), '') : title;
  const rawId = text(record.id || record.generatedId || record.generated_internal_id || record.awardId, 220) || `evidence-${hash(companyNames.join('|') + title + sourceUrl)}`;
  const id = snapshot && !rawId.startsWith('official-') ? `official-${rawId}` : rawId;
  const verification = text(record.verification, 240);
  // Structured award snapshots are official records. Government RSS announcements remain announcements.
  const rank = official ? snapshot ? 4 : 3 : /company announcement|company release|official company/i.test(verification) ? 2 : 1;
  const eventCategory = category(record, official);
  const allText = [title, summary, record.awardingAgency, record.fundingAgency, record.agency, record.program, record.recipientName, record.naicsDescription, record.productServiceDescription].map(value => text(value)).filter(Boolean).join(' ');
  const officialFacts = official ? {
    awardId: text(record.awardId || record.contractId || record.generatedId, 180),
    agency: text(record.awardingAgency || record.agency, 240),
    fundingAgency: text(record.fundingAgency, 240),
    obligations: number(record.obligations ?? record.totalObligated ?? record.amount),
    ceiling: number(record.ceiling ?? record.baseAndAllOptionsValue),
    actionDate: date(record.actionDate || record.latestActionDate || record.published),
    awardType: text(record.awardType || record.type, 120),
    description: normalized(text(record.description || record.summary, 5000)),
    transactions: JSON.stringify((Array.isArray(record.transactions) ? record.transactions : []).map((transaction: any) => ({
      id: text(transaction.id, 180), actionDate: date(transaction.actionDate), modification: text(transaction.modification, 100),
      obligation: number(transaction.obligation), type: text(transaction.type, 120), description: normalized(text(transaction.description, 5000)),
    })).sort((a: any, b: any) => a.actionDate.localeCompare(b.actionDate) || a.id.localeCompare(b.id))),
  } : null;
  return {id, title, summary, category: eventCategory, companies: ordered(companyNames), published, firstSeen, lastSeen,
    source: {recordId: id, url: sourceUrl, title, published, fetchedAt, source: sourceName}, rank,
    contractIds: contractIds(record, `${title} ${summary}`, official), amounts: monetaryValues(record, `${title} ${summary}`),
    tokens: titleTokens(matchingTitle, companyNames), normalized: normalized(matchingTitle), parties: eventCategory === 'Teaming' ? parties(matchingTitle) : [],
    actions: actions(title, eventCategory), officialFacts, text: allText};
}
function intersects(a: string[], b: string[]): boolean { return a.some(value => b.includes(value)); }
function sameAmounts(a: number[], b: number[]): boolean {
  return a.some(value => b.some(other => Math.abs(value - other) <= Math.max(1, Math.max(Math.abs(value), Math.abs(other)) * 0.005)));
}
function compatible(a: Candidate, b: Candidate): boolean {
  if ((a.category !== b.category && !(contractCategory(a.category) && contractCategory(b.category))) || !intersects(a.companies.map(lower), b.companies.map(lower))) return false;
  if (a.id === b.id) return true;
  if (a.contractIds.length && b.contractIds.length) return intersects(a.contractIds, b.contractIds);
  const sameUrl = a.source.url && a.source.url === b.source.url;
  // A recurring landing page is not evidence that two differently titled events are identical.
  if (sameUrl && a.normalized === b.normalized) return true;
  if (!a.published || !b.published || Math.abs(Date.parse(a.published) - Date.parse(b.published)) > 7 * DAY) return false;
  if (a.category === 'Teaming' && a.parties.length >= 2 && b.parties.length >= 2 && a.parties.join('|') !== b.parties.join('|')) return false;
  if (a.normalized === b.normalized) return true;
  if (a.amounts.length && b.amounts.length && !sameAmounts(a.amounts, b.amounts)) return false;
  const common = a.tokens.filter(token => b.tokens.includes(token)).length;
  const dice = 2 * common / Math.max(1, a.tokens.length + b.tokens.length);
  const moneyMatch = sameAmounts(a.amounts, b.amounts);
  // Similar amount plus a distinctive context can support a match. Amount alone cannot.
  if (moneyMatch && common >= 2 && dice >= 0.70 && a.tokens.some(token => !/^usd\d+$/.test(token) && b.tokens.includes(token))) return true;
  return common >= 3 && dice >= (a.category === 'Teaming' ? 0.88 : 0.84);
}
function targetMatches(values: string[], rawText: string): string[] {
  const lexical = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const haystacks = [` ${normalized(rawText)} `, ` ${lexical(rawText)} `];
  return values.filter(value => {
    const needles = [normalized(value), lexical(value)].filter(Boolean);
    return needles.some(needle => haystacks.some(haystack => haystack.includes(` ${needle} `)));
  });
}
function score(group: Candidate[], preferences: IntelligencePreferences) {
  const eventCategory = group[0].category, allText = group.map(item => item.text).join(' ');
  const companies = ordered(group.flatMap(item => item.companies));
  const matches = {
    agencies: targetMatches(preferences.agencies, allText), programs: targetMatches(preferences.programs, allText),
    capabilities: targetMatches(preferences.capabilities, allText), companies: targetMatches(preferences.companies, companies.join(' ')),
  };
  const base = eventCategory === 'Acquisition' ? 40 : eventCategory === 'Teaming' ? 35 : contractCategory(eventCategory) ? 30 : 10;
  const reasons = [`${eventCategory}: ${base} points`]; let points = base;
  for (const [key, weight] of [['companies',20],['agencies',25],['programs',30],['capabilities',15]] as const) {
    if (matches[key].length) {points += weight; reasons.push(`Target ${key}: ${matches[key].join(', ')} (+${weight})`);}
  }
  const amounts = numeric(group.flatMap(item => item.amounts));
  if (contractCategory(eventCategory) && preferences.minAwardValue > 0 && amounts.some(value => value >= preferences.minAwardValue)) {
    points += 15; reasons.push(`Reported value meets $${preferences.minAwardValue.toLocaleString('en-US')} threshold (+15)`);
  }
  const belowAwardThreshold = contractCategory(eventCategory) && preferences.minAwardValue > 0 && (!amounts.length || Math.max(...amounts) < preferences.minAwardValue);
  if (belowAwardThreshold) reasons.push(amounts.length ? 'Reported value is below the configured award threshold' : 'Award value is not available; threshold cannot be confirmed');
  return {relevanceScore: Math.min(100, points), relevanceReasons: reasons, targetMatches: matches,
    alertEligible: points >= preferences.minimumScore && !belowAwardThreshold,
    relevanceMethod: 'Rules based on configured text matches and reported values. This score is not a win probability.'};
}
function latest(values: string[]): string { return values.filter(Boolean).sort().at(-1) || ''; }
function earliest(values: string[]): string { return values.filter(Boolean).sort()[0] || ''; }
function previousFor(group: Candidate[], previous: any[], used: Set<string>): any {
  const ids = new Set(group.map(item => item.id));
  const contracts = ordered(group.flatMap(item => item.contractIds));
  const companies = group.flatMap(item => item.companies).map(lower);
  return previous.filter(event => !used.has(event.id) && (event.category === group[0].category || contractCategory(event.category) && contractCategory(group[0].category)))
    .map(event => ({event, overlap: (event.recordIds || []).filter((id: string) => ids.has(id)).length,
      contract: intersects(event.contractIds || event.materialFacts?.contractIds || [], contracts) && intersects((event.companies || []).map(lower), companies)}))
    .filter(match => match.overlap || match.contract).sort((a, b) => b.overlap - a.overlap || Number(b.contract) - Number(a.contract) || String(a.event.id).localeCompare(String(b.event.id)))[0]?.event;
}

/** All evidence remains in sources and recordIds; grouping does not delete or conceal records. */
export function clusterEvents(records: any[], awards: any[], preferences: any, previous: any[] = []): any[] {
  const settings = normalizePreferences(preferences);
  const candidates = [...(Array.isArray(records) ? records.slice(0,10000).map(record => makeCandidate(record)) : []),
    ...(Array.isArray(awards) ? awards.slice(0,10000).map(record => makeCandidate(record, true)) : [])]
    .filter((item): item is Candidate => !!item)
    .sort((a, b) => b.rank - a.rank || a.firstSeen.localeCompare(b.firstSeen) || a.id.localeCompare(b.id));
  const groups: Candidate[][] = [];
  for (const candidate of candidates) {
    // Complete-link checks prevent transitive chains from merging two conflicting awards or partners.
    const group = groups.find(items => items.every(item => compatible(item, candidate)));
    if (group) {if (!group.some(item => item.id === candidate.id && item.source.url === candidate.source.url)) group.push(candidate);}
    else groups.push([candidate]);
  }
  const old = Array.isArray(previous) ? previous : [], used = new Set<string>();
  return groups.map(group => {
    const prior = previousFor(group, old, used); if (prior) used.add(prior.id);
    const anchor = group[0], companies = ordered(group.flatMap(item => item.companies));
    const contracts = ordered(group.flatMap(item => item.contractIds));
    const recordIds = ordered(group.map(item => item.id));
    const id = prior?.id || `event-${hash(anchor.category + '|' + companies.map(lower).join('|') + '|' + (contracts[0] || anchor.id))}`;
    const evidence = group.map(item => item.source).filter((item, index, list) => list.findIndex(other => other.recordId === item.recordId && other.url === item.url) === index)
      .sort((a, b) => a.published.localeCompare(b.published) || a.recordId.localeCompare(b.recordId));
    const authoritative = group.filter(item => item.rank >= 3);
    const anchorRecordId = prior?.materialFacts?.anchorRecordId || anchor.id;
    const retainedAnchor = group.find(item => item.id === anchorRecordId);
    const facts = {
      contractIds: contracts, amounts: numeric((authoritative.length ? authoritative : group).flatMap(item => item.amounts)),
      actions: ordered(group.flatMap(item => item.actions)),
      // One current snapshot per official record, including true value and status changes.
      official: authoritative.map(item => ({recordId: item.id, ...item.officialFacts})).sort((a, b) => a.recordId.localeCompare(b.recordId)),
      // New syndication does not change an anchor. An actual update to that source still does.
      anchorRecordId,
      meaning: retainedAnchor?.normalized || prior?.materialFacts?.meaning || anchor.normalized,
      summaryFingerprint: retainedAnchor ? hash(normalized(retainedAnchor.summary)) : prior?.materialFacts?.summaryFingerprint || hash(normalized(anchor.summary)),
    };
    const materialFingerprint = hash(JSON.stringify({category: anchor.category, companies, ...facts}));
    const rank = Math.max(...group.map(item => item.rank));
    const confidence = rank >= 3 ? 'Official record' : rank === 2 ? 'Company announcement' : 'Discovery';
    const confidenceReason = rank >= 3 ? 'Includes a structured official award record. A contract action may be a modification or adjustment, not a new award. Values retain the source agency definitions.'
      : rank === 2 ? 'Includes an identified company announcement. Independent corroboration may still be required.'
      : 'Public news discovery or user-supplied evidence. Verify the linked source before making a decision.';
    let changeSummary = prior ? 'No material change. Additional source links do not create a new alert.' : `New ${anchor.category.toLowerCase()} event.`;
    if (prior && prior.materialFingerprint !== materialFingerprint) {
      const changes: string[] = [];
      if (JSON.stringify(prior.materialFacts?.amounts) !== JSON.stringify(facts.amounts)) changes.push('reported award values');
      if (JSON.stringify(prior.materialFacts?.actions) !== JSON.stringify(facts.actions)) changes.push('contract action');
      if (JSON.stringify(prior.materialFacts?.official) !== JSON.stringify(facts.official)) changes.push('official award details');
      if (JSON.stringify(prior.materialFacts?.contractIds) !== JSON.stringify(facts.contractIds)) changes.push('contract identifiers');
      if (prior.materialFacts?.meaning !== facts.meaning || prior.materialFacts?.summaryFingerprint !== facts.summaryFingerprint) changes.push('source event details');
      changeSummary = changes.length ? `Changed ${changes.join(', ')}. Review the linked evidence.` : 'Event classification or participants changed. Review the linked evidence.';
    }
    return {
      id, title: anchor.title, summary: anchor.summary, category: anchor.category, companies, recordIds, sources: evidence,
      firstSeen: earliest([prior?.firstSeen || '', ...group.map(item => item.firstSeen)]), lastSeen: latest(group.map(item => item.lastSeen)),
      published: latest(group.map(item => item.published)), confidence, confidenceReason, changeSummary,
      contractIds: contracts, reportedValues: facts.amounts, materialFacts: facts, materialFingerprint,
      materialChanged: !prior || prior.materialFingerprint !== materialFingerprint,
      sourceCount: evidence.length, ...score(group, settings),
    };
  }).sort((a, b) => b.published.localeCompare(a.published) || b.relevanceScore - a.relevanceScore || a.id.localeCompare(b.id));
}
