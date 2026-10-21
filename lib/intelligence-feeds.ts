/** Public-source collection. Network destinations are fixed here, never supplied by clients. */
export type Competitor = { id: string; name: string; aliases: string; website: string };
export type CollectedItem = { id: string; company: string; category: string; title: string; summary: string; url: string; published: string; source: string; verification: string; priority: string };
export type Health = { source: string; status: string; detail: string };
export type CompanyCoverage = {
  id: string; name: string; status: 'ok' | 'empty' | 'error'; checkedAt: string;
  items: number; latestPublished: string; sources: string[]; errors: string[];
};
type FeedEntry = { title: string; link: string; description: string; published: string; publisher: string };
type Budget = { used: number; maximum: number };
type CoverageState = { row: CompanyCoverage; successful: Set<string> };
const MAX_BYTES = 1024 * 1024, MAX_COMPANIES = 30, MAX_PER_COMPANY = 15, WINDOW_MS = 45 * 86400000;
const ALLOWED_HOSTS = new Set(['www.bing.com', 'news.google.com', 'www.parsons.com', 'investors.kbr.com', 'www.defense.gov', 'www.war.gov']);

function allowedUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !ALLOWED_HOSTS.has(url.hostname)) throw new Error('Source destination is not allowed');
  return url;
}
async function fetchText(raw: string, budget: Budget): Promise<string> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    let url = allowedUrl(raw);
    for (let redirects = 0; redirects < 3; redirects++) {
      if (budget.used >= budget.maximum) throw new Error('Collection request budget reached; source deferred');
      budget.used++;
      const response = await fetch(url.toString(), {signal: controller.signal, redirect: 'manual', headers: {Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8'}});
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel(); const location = response.headers.get('location');
        if (!location) throw new Error('Source redirect has no destination');
        url = allowedUrl(new URL(location, url).toString()); continue;
      }
      if (!response.ok) {await response.body?.cancel(); throw new Error(`Source returned HTTP ${response.status}`);}
      if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) {await response.body?.cancel(); throw new Error('Source exceeds the 1 MB collection limit');}
      if (!response.body) throw new Error('Source returned an empty response');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
          if (size > MAX_BYTES) {await reader.cancel(); throw new Error('Source exceeds the 1 MB collection limit');}
          text += decoder.decode(chunk.value, {stream: true});
        }
        return text + decoder.decode();
      } finally {reader.releaseLock();}
    }
    throw new Error('Source exceeded the redirect limit');
  } finally {clearTimeout(timer);}
}
function decodeEntities(value: string): string {
  const named: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',hellip:'…'};
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
}
function plain(value: string): string {
  return decodeEntities(decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function tag(xml: string, name: string): string {return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`,'i').exec(xml)?.[1] ?? '';}
function parseFeed(xml: string): FeedEntry[] {
  // No XML execution, DTD expansion, external entities, or publisher-page fetching.
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error('Source did not return a supported RSS or Atom feed');
  const pattern = /<item(?:\s|>)/i.test(xml) ? /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi : /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi;
  return Array.from(xml.matchAll(pattern)).slice(0,100).map(match => {
    const item = match[1], date = new Date(plain(tag(item,'pubDate') || tag(item,'published') || tag(item,'updated') || tag(item,'dc:date')));
    const atomLink = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i.exec(item)?.[1] || '';
    return {title:plain(tag(item,'title')).slice(0,500),link:plain(tag(item,'link') || atomLink),
      description:plain(tag(item,'description') || tag(item,'content:encoded') || tag(item,'summary') || tag(item,'content')),
      published:Number.isNaN(date.getTime()) ? '' : date.toISOString(),publisher:plain(tag(item,'source') || tag(item,'News:Source') || tag(item,'dc:creator'))};
  }).filter(item => item.title && item.link);
}
function safeLink(raw: string): string | null {
  try {
    let url = new URL(raw);
    // Bing's RSS wrapper may use HTTP. Decode only its known publisher parameter, without fetching it.
    if (url.hostname === 'www.bing.com' && url.pathname === '/news/apiclick.aspx') {
      const publisher = url.searchParams.get('url'); if (!publisher) return null; url = new URL(publisher);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_') || ['fbclid','gclid'].includes(key.toLowerCase())) url.searchParams.delete(key);
    return url.toString();
  } catch {return null;}
}
function aliases(company: Competitor): string[] {
  const canonical = /^SAIC$/i.test(company.name.trim()) ? ['Science Applications International','Science Applications'] : [];
  return [...new Set([company.name,...canonical,...company.aliases.split(/[,;|\n]/)].map(value => value.trim()).filter(value => value.length >= 2 && value.toUpperCase() !== 'SNC'))];
}
function escapeRegex(value: string): string {return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
const DEFENSE_CONTEXT = /\b(?:defen[cs]e|military|aerospace|Pentagon|Navy|Army|Air Force|Space Force|Marine Corps|government|radar|missile|unmanned|shipbuilding|naval|earnings|NYSE)\b/i;
function companyMatch(text: string, company: Competitor): RegExpExecArray | null {
  const name = company.name.trim();
  if (/^v2x(?:\s+(?:inc\.?|incorporated|corporation|corp\.?))?$/i.test(name)) {
    const explicit = /\b(?:V2X\s+(?:Inc\.?|Incorporated|Corporation|Corp\.?)|Vectrus|VVX)\b/i.test(text);
    const vehicle = /\b(?:vehicle.to.everything|automotive|connected vehicles?|connected cars?|Qualcomm|AppyWay|road safety|traffic signals?)\b/i.test(text);
    if (!explicit && (!DEFENSE_CONTEXT.test(text) || vehicle)) return null;
  }
  if (/^HII$/i.test(name) && !/\b(?:Huntington Ingalls|Ingalls|Newport News|Mission Technologies)\b/i.test(text) && !DEFENSE_CONTEXT.test(text)) return null;
  if (/^Saab(?: AB)?$/i.test(name) && !/\b(?:Saab AB|Gripen|GlobalEye|Carl.Gustaf)\b/i.test(text) && !DEFENSE_CONTEXT.test(text)) return null;
  if (/^Leonardo(?: S\.?p\.?A\.?)?$/i.test(name) && !/\b(?:Leonardo S\.?p\.?A\.?|Leonardo DRS|helicopter|AgustaWestland)\b/i.test(text) && !DEFENSE_CONTEXT.test(text)) return null;
  if (/^RTX(?: Corporation)?$/i.test(name) && !/\b(?:Raytheon|RTX Corporation|Pratt|Collins Aerospace)\b/i.test(text) && !DEFENSE_CONTEXT.test(text)) return null;
  if (/^Kratos(?: Defense.*)?$/i.test(name) && !/\bKratos Defense\b/i.test(text) && !DEFENSE_CONTEXT.test(text)) return null;
  if (/^Parsons(?: Corporation)?$/i.test(name) && !/\b(?:Parsons Corporation|Parsons Corp\.?|NYSE\s*:?\s*PSN)\b/i.test(text) && !DEFENSE_CONTEXT.test(text)) return null;
  if (/^SAIC$/i.test(name)) {
    const explicit = /\b(?:Science Applications(?: International)?|(?:NYSE|NASDAQ)\s*:?\s*SAIC)\b/i.test(text);
    if (/\bSAIC\s+Motor\b/i.test(text) && !explicit) return null;
    if (!explicit && !/\b(?:defen[cs]e|military|Pentagon|Navy|Army|Air Force|Space Force|Marine Corps|government|mission|cyber|federal|intelligence|NASA|national security)\b/i.test(text)) return null;
  }
  for (const alias of aliases(company)) {const match = new RegExp(`(^|[^a-z0-9])${escapeRegex(alias)}(?=$|[^a-z0-9])`,'i').exec(text); if (match) return match;}
  return null;
}
function bingQuery(company: Competitor): string {
  // Bing News RSS often returns an empty channel for grouped OR expressions.
  // Keep this provider's query simple; aliases remain in matching and the Google fallback.
  const name = company.name.trim();
  if (/^HII$/i.test(name)) return '"Huntington Ingalls"';
  if (/^V2X$/i.test(name)) return '"V2X" defense';
  if (/^RTX(?: Corporation)?$/i.test(name)) return '"Raytheon"';
  if (/^Saab(?: AB)?$/i.test(name)) return '"Saab" defense';
  if (/^Leonardo(?: S\.?p\.?A\.?)?$/i.test(name)) return '"Leonardo" aerospace';
  if (/^Kratos(?: Defense.*)?$/i.test(name)) return '"Kratos" defense';
  if (/^Parsons(?: Corporation)?$/i.test(name)) return '"Parsons" defense';
  if (/^SAIC$/i.test(name)) return '"Science Applications International"';
  if (/^ManTech$/i.test(name)) return '"ManTech" intelligence';
  if (/^Sierra Nevada Corporation$/i.test(name)) return '"Sierra Nevada" defense';
  return `"${name.replace(/["()]/g,' ')}"`;
}
function searchQuery(company: Competitor): string {
  const name = company.name;
  if (/^V2X$/i.test(name)) return '("V2X Inc" OR "Vectrus" OR ("V2X" (defense OR military OR aerospace OR VVX)))';
  if (/^HII$/i.test(name)) return '("Huntington Ingalls" OR "HII Mission Technologies" OR ("HII" (defense OR Navy OR shipbuilding)))';
  if (/^Saab(?: AB)?$/i.test(name)) return '("Saab AB" OR ("Saab" (defense OR defence OR military OR aerospace OR Gripen)))';
  if (/^Leonardo(?: S\.?p\.?A\.?)?$/i.test(name)) return '("Leonardo SpA" OR ("Leonardo" (defense OR defence OR aerospace OR helicopter OR radar)))';
  if (/^RTX(?: Corporation)?$/i.test(name)) return '("RTX Corporation" OR "Raytheon" OR ("RTX" (defense OR aerospace OR Pratt OR Collins)))';
  if (/^Kratos(?: Defense.*)?$/i.test(name)) return '("Kratos Defense" OR ("Kratos" (defense OR military OR aerospace OR unmanned)))';
  const terms = aliases(company).slice(0,4).map(value => `"${value.replace(/["()]/g,' ')}"`);
  return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
}
function category(title: string, company: Competitor): string {
  const passiveShareTrade = /\bshares?\b.{0,45}\b(?:newly\s+)?(?:acquired|purchased|bought|sold)\s+by\b/i.test(title);
  const insiderShareTrade = /\b(?:director|officer|insider|CEO|CFO)\b/i.test(title)
    && /\b(?:shares?|stock award|stock options?)\b/i.test(title)
    && /\b(?:acquir(?:e[sd]?|ing)|purchas(?:e[sd]?|ing)|buys?|bought|sold|sells?|award)\b/i.test(title);
  const eligibilityOnly = /\bcontract eligibility\b/i.test(title) && !/\b(?:awarded|wins?|secures?|task order|IDIQ)\b|\$\s*[\d,.]+/i.test(title);
  const institutionalShareTrade = /\b(?:acquir(?:e[sd]?|ing)|purchas(?:e[sd]?|ing)|buys?|bought|sold|sells?)\b.{0,70}\b[\d,.]+\s+shares?\b/i.test(title);
  const technicalTeaming = /\b(?:manned.unmanned|machine.to.machine|drone teaming|teaming with (?:fleet )?aircraft)\b/i.test(title);
  if (passiveShareTrade || insiderShareTrade || institutionalShareTrade || eligibilityOnly || technicalTeaming) return 'News';
  const clauses = title.split(/[,;|]|\s+[•·]\s+/), tied = (pattern: RegExp) => clauses.some(clause => pattern.test(clause) && companyMatch(clause,company));
  if (tied(/\b(acquir(?:e[sd]?|ing)|acquisition|merg(?:e[sd]?|er)|divest(?:iture|s|ed)?)\b/i)) return 'Acquisition';
  if (/\bjoint venture\b/i.test(title) && /\b(?:awards?|awarded|wins?|secures?)\b.*\bcontract\b|\bcontract\b.*\b(?:awards?|awarded)\b/i.test(title)) return 'Contract award';
  // Commas can separate joint subjects, as in "L3Harris, Skydio Partner ...".
  // Accept a short subject list only; an earlier earnings or other news clause is not a subject.
  const jointVerb = /\b(?:to\s+)?(?:partners?|teams?\s+up|announce(?:s)?\s+(?:a\s+)?partnership)\b/i.exec(title);
  const subjects = jointVerb ? title.slice(0,jointVerb.index).trim() : '';
  const subjectList = subjects.split(/,\s*|\s+(?:and|&)\s+/i).filter(Boolean);
  const jointSubjects = subjects.length <= 140 && subjectList.length >= 2 && subjectList.length <= 4
    && !/[:;|]|\b(?:reports?|earnings|announces?|wins?|acquires?|merger|expands?|unveils?|meanwhile)\b/i.test(subjects)
    && !!companyMatch(subjects,company);
  if (jointSubjects || tied(/\b(team(?:ing|s|ed)(?: up)?|team up|partner(?:ship|s|ed)?|joint venture|alliance|memorandum of understanding|MOU)\b/i)) return 'Teaming';
  if (tied(/\b(contract|task order|IDIQ|award(?:ed)?\s+\$|wins?\s+\$|secures?\s+\$)\b/i) || tied(/\b(?:awarded|wins?|secures?)\b.*\$\s*[\d,.]+/i)) return 'Contract award';
  return 'News';
}
function priority(text: string, kind: string): string {
  if (kind === 'Acquisition') return 'High';
  if (kind === 'Contract award') for (const match of text.matchAll(/(?:\$|USD\s*)([\d,.]+)\s*(billion|million|bn|[bmk])?\b/gi)) {
    const scale = (match[2] || '').toLowerCase(), amount = Number(match[1].replace(/,/g,'')) * (['billion','bn','b'].includes(scale) ? 1e9 : ['million','m'].includes(scale) ? 1e6 : scale === 'k' ? 1e3 : 1);
    if (amount >= 100e6) return 'High';
  }
  return 'Normal';
}
export function relevantToCompany(text: string, company: Competitor): boolean {return !!companyMatch(text,company);}
export function classifyForCompany(title: string, company: Competitor): {category: string; priority: string} {
  const kind = category(title,company);
  return {category:kind,priority:priority(title,kind)};
}
export function normalizeTitle(title: string, publisher = ''): string {
  let value = plain(title);
  if (publisher) value = value.replace(new RegExp(`\\s+(?:-|–|—|\\|)\\s+${escapeRegex(publisher.trim())}\\s*$`,'i'),'');
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
async function stableId(entry: FeedEntry, company: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${normalizeTitle(entry.title,entry.publisher)}\n${company.toLowerCase()}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}
function current(entry: FeedEntry, at: number): boolean {const date = Date.parse(entry.published); return Number.isFinite(date) && date >= at - WINDOW_MS && date <= at + 5 * 60000;}
async function record(entry: FeedEntry, company: Competitor, source: string, verification: string, at: number, overrideCategory?: string): Promise<CollectedItem | null> {
  const url = safeLink(entry.link); if (!url || !current(entry,at)) return null;
  const kind = overrideCategory || category(entry.title,company);
  return {id:await stableId(entry,company.name),company:company.name,category:kind,title:entry.title,summary:entry.description.slice(0,350),url,
    published:entry.published,source,verification,priority:priority(`${entry.title} ${entry.description}`,kind)};
}
function errorDetail(error: unknown): string {return error instanceof Error && error.name === 'AbortError' ? 'Source timed out after 12 seconds' : error instanceof Error ? error.message.slice(0,160) : 'Source could not be collected';}
async function pooled<T>(values: T[], concurrency: number, work: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({length:Math.min(concurrency,values.length)},async () => {while (next < values.length) {const value = values[next++]; await work(value);}}));
}

export async function collectFeeds(input: Competitor[]): Promise<{items: CollectedItem[]; health: Health[]; companies: CompanyCoverage[]}> {
  const companies = input.filter(company => company && typeof company.name === 'string' && company.name.trim()).slice(0,MAX_COMPANIES)
    .map(company => ({...company,name:company.name.trim().slice(0,150),aliases:typeof company.aliases === 'string' ? company.aliases.slice(0,1000) : ''}));
  const items: CollectedItem[] = [], health: Health[] = [], at = Date.now(), budget = {used:0,maximum:41};
  const coverage = new Map<string,CoverageState>(companies.map(company => [company.id,{row:{id:company.id,name:company.name,status:'error',checkedAt:'',items:0,latestPublished:'',sources:[],errors:[]},successful:new Set<string>()}]));
  if (!companies.length) return {items,health,companies:[]};
  if (input.length > MAX_COMPANIES) health.push({source:'Collection limit',status:'limited',detail:'This run checks the first 30 active competitors.'});
  const attempted = (company: Competitor, source: string) => {const state = coverage.get(company.id)!; if (!state.row.sources.includes(source)) state.row.sources.push(source); return state;};
  const failures: {company: Competitor; provider: 'Bing News'|'Google News'; detail: string}[] = [], accepted = new Map<string,number>();
  async function discovery(company: Competitor, provider: 'Bing News'|'Google News', retry = false): Promise<void> {
    const state = attempted(company,provider), source = `${company.name} · ${provider}${retry ? ' retry' : ''}`;
    const url = new URL(provider === 'Bing News' ? 'https://www.bing.com/news/search' : 'https://news.google.com/rss/search');
    url.searchParams.set('q',provider === 'Bing News' ? bingQuery(company) : `${searchQuery(company)} when:45d`);
    if (provider === 'Bing News') {url.searchParams.set('format','rss'); url.searchParams.set('mkt','en-US');}
    else {url.searchParams.set('hl','en-US'); url.searchParams.set('gl','US'); url.searchParams.set('ceid','US:en');}
    try {
      const entries = parseFeed(await fetchText(url.toString(),budget)); let matches = 0;
      for (const entry of entries) {
        if (!companyMatch(`${entry.title} ${entry.description}`,company)) continue;
        const item = await record(entry,company,entry.publisher ? `${provider} · ${entry.publisher}` : provider,'Discovery; corroboration needed',at);
        if (item) {items.push(item); matches++;}
      }
      state.successful.add(provider); accepted.set(company.id,(accepted.get(company.id) || 0) + matches);
      health.push({source,status:matches ? 'ok' : 'empty',detail:`${matches} current competitor matches from ${entries.length} entries; original dates retained; discovery needs corroboration`});
    } catch (error) {
      const detail = errorDetail(error); state.row.errors.push(`${provider}${retry ? ' retry' : ''}: ${detail}`); failures.push({company,provider,detail}); health.push({source,status:'error',detail});
    }
  }
  // Every company gets an individual request before optional work. Busy competitors cannot crowd out quieter ones.
  await pooled(companies,3,company => discovery(company,'Bing News'));
  const primary = [{name:'Parsons newsroom',company:'Parsons',url:'https://www.parsons.com/feed/'},{name:'KBR investor releases',company:'KBR',url:'https://investors.kbr.com/rss/pressrelease.aspx'}];
  await pooled(primary,2,async feed => {
    // These fixed feeds are bound to directory identities, not article relevance rules.
    const matching = companies.filter(company => company.name.trim().toLowerCase() === feed.company.toLowerCase()); if (!matching.length) return;
    matching.forEach(company => attempted(company,feed.name));
    try {
      const entries = parseFeed(await fetchText(feed.url,budget)); let matches = 0;
      for (const company of matching) {
        coverage.get(company.id)!.successful.add(feed.name);
        for (const entry of entries) {const item = await record(entry,company,feed.name,'Company announcement',at); if (item) {items.push(item); matches++;}}
      }
      health.push({source:feed.name,status:matches ? 'ok' : 'empty',detail:`${matches} announcements published in the last 45 days from ${entries.length} entries`});
    } catch (error) {const detail = errorDetail(error); matching.forEach(company => coverage.get(company.id)!.row.errors.push(`${feed.name}: ${detail}`)); health.push({source:feed.name,status:'error',detail});}
  });
  const bulletinSource = 'Defense contract bulletins'; companies.forEach(company => attempted(company,bulletinSource));
  try {
    const entries = parseFeed(await fetchText('https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=20',budget)).filter(entry => current(entry,at)).slice(0,4);
    let matches = 0, successful = 0, failed = 0;
    await pooled(entries,2,async entry => {
      try {
        const url = allowedUrl(entry.link); if (!['www.defense.gov','www.war.gov'].includes(url.hostname)) throw new Error('Bulletin link is not a government source');
        const html = await fetchText(url.toString(),budget), body = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(html)?.[1] || html, text = plain(body);
        if (!/\b(?:contract|awarded|modification|task order)\b/i.test(text) || text.length < 150) throw new Error('Government response did not contain a usable contract bulletin');
        successful++;
        for (const company of companies) {
          const match = companyMatch(text,company); if (!match) continue;
          const position = match.index + match[1].length, start = Math.max(0,position - 90), description = `${start ? '…' : ''}${text.slice(start,start + 345)}`;
          const item = await record({...entry,title:`${company.name}: ${entry.title}`,description},company,bulletinSource,'Government announcement',at,'Contract award');
          if (item) {items.push(item); matches++;}
        }
      } catch (error) {failed++; health.push({source:`${bulletinSource} · ${entry.title}`,status:'error',detail:errorDetail(error)});}
    });
    if (successful) companies.forEach(company => coverage.get(company.id)!.successful.add(bulletinSource));
    if (failed) companies.forEach(company => coverage.get(company.id)!.row.errors.push(`${bulletinSource}: ${failed} of ${entries.length} bulletin pages failed`));
    health.push({source:bulletinSource,status:failed ? successful ? 'partial' : 'error' : successful ? 'ok' : 'empty',detail:`${successful} of ${entries.length} recent bulletin pages checked; ${failed} failed; ${matches} competitor mentions`});
  } catch (error) {const detail = errorDetail(error); companies.forEach(company => coverage.get(company.id)!.row.errors.push(`${bulletinSource}: ${detail}`)); health.push({source:bulletinSource,status:'error',detail});}
  // Mandatory sources run first. Reserve the remaining budget for at most ten company-specific fallbacks.
  const candidates = companies.filter(company => !(accepted.get(company.id) || 0)).sort((a,b) => Number(coverage.get(a.id)!.successful.has('Bing News')) - Number(coverage.get(b.id)!.successful.has('Bing News')));
  await pooled(candidates.slice(0,10),2,company => discovery(company,'Google News'));
  if (candidates.length > 10) health.push({source:'Google News fallback limit',status:'limited',detail:`${candidates.length - 10} companies had no current Bing matches; further fallback deferred to keep this run within its request budget`});
  // Retry a transient failure once, with spare requests only. A 403 block is never retried.
  const retried = new Set<string>();
  for (const failure of [...failures]) {
    const key = `${failure.company.id}|${failure.provider}`;
    if (budget.used >= budget.maximum || retried.has(key) || accepted.get(failure.company.id) || !/(?:HTTP (?:429|5\d\d)|timed out|fetch failed|network)/i.test(failure.detail)) continue;
    retried.add(key); await discovery(failure.company,failure.provider,true);
  }
  const unique = new Map<string,CollectedItem>();
  for (const item of items) {const previous = unique.get(item.id); if (!previous || previous.verification.startsWith('Discovery') && !item.verification.startsWith('Discovery')) unique.set(item.id,item);}
  const fair: CollectedItem[] = [];
  for (const company of companies) {
    const selected = [...unique.values()].filter(item => item.company === company.name).sort((a,b) => b.published.localeCompare(a.published)).slice(0,MAX_PER_COMPANY); fair.push(...selected);
    const state = coverage.get(company.id)!; state.row.items = selected.length; state.row.latestPublished = selected[0]?.published || ''; state.row.checkedAt = new Date().toISOString();
    const failedFallback = state.row.sources.includes('Google News') && !state.successful.has('Google News');
    state.row.status = selected.length ? 'ok' : failedFallback ? 'error' : state.successful.size ? 'empty' : 'error';
  }
  return {items:fair.sort((a,b) => b.published.localeCompare(a.published)),health:health.sort((a,b) => a.source.localeCompare(b.source)),companies:companies.map(company => coverage.get(company.id)!.row)};
}
