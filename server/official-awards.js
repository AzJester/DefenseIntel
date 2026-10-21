const ORIGIN = 'https://api.usaspending.gov';
const SEARCH_PATH = '/api/v2/search/spending_by_transaction/';
const MAX_BYTES = 2 * 1024 * 1024;
const FIELDS = ['Award ID', 'Recipient Name', 'Recipient UEI', 'Action Date', 'Transaction Amount', 'Mod',
    'Transaction Description', 'Awarding Agency', 'Awarding Sub Agency', 'Award Type', 'Action Type', 'generated_internal_id'];
function text(value, maximum = 500) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, maximum) : '';
}
function amount(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(number) ? number : null;
}
function date(value) {
    const candidate = text(value, 40).slice(0, 10);
    const timestamp = Date.parse(candidate);
    return /^\d{4}-\d{2}-\d{2}$/.test(candidate) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === candidate ? candidate : '';
}
function normalized(value) {
    return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function nameMatch(name, term) {
    const recipient = ` ${normalized(name)} `, needle = normalized(term);
    return needle.length >= 3 && recipient.includes(` ${needle} `);
}
function uei(value) {
    const result = text(value, 20).toUpperCase();
    return /^[A-Z0-9]{12}$/.test(result) ? result : '';
}
function targets(companies, mappings) {
    return companies.slice(0, 30).map(company => {
        const matching = mappings.filter(mapping => mapping.company === company.name).slice(0, 20);
        const terms = [company.name, ...company.aliases.split(/[,;|\n]/), ...matching.map(mapping => mapping.name)]
            .map(value => text(value, 120)).filter(value => value.length >= 3);
        // These expand a corporate acronym, rather than asserting subsidiary ownership.
        if (/^SAIC$/i.test(company.name))
            terms.push('Science Applications International');
        if (/^HII$/i.test(company.name))
            terms.push('Huntington Ingalls');
        return { company, terms: [...new Set(terms)].slice(0, 12), mappings: matching };
    });
}
function identify(row, group) {
    const recipient = text(row['Recipient Name']), recipientUei = uei(row['Recipient UEI']);
    for (const target of group) {
        const exact = target.mappings.find(mapping => recipientUei && uei(mapping.uei) === recipientUei);
        if (exact)
            return { target, basis: exact.verified ? 'Verified entity UEI' : 'Entity UEI (unverified)', verified: exact.verified };
    }
    for (const target of group) {
        // Do not assign automotive SAIC to the defense services company.
        if (/^SAIC$/i.test(target.company.name) && /\b(?:SAIC MOTOR|SHANGHAI AUTOMOTIVE)\b/i.test(recipient))
            continue;
        const explicit = target.mappings.find(mapping => mapping.name && nameMatch(recipient, mapping.name));
        if (explicit)
            return { target, basis: explicit.verified ? 'Verified entity name' : 'Entity name (unverified)', verified: explicit.verified };
        if (target.terms.some(term => nameMatch(recipient, term)))
            return { target, basis: 'Recipient name (unverified)', verified: false };
    }
    return null;
}
async function request(path, body) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port)
        throw new Error('Official source destination is not allowed');
    if (url.pathname !== SEARCH_PATH && !/^\/api\/v2\/awards\/[^/]+\/$/.test(url.pathname))
        throw new Error('Official source path is not allowed');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 14000);
    try {
        const response = await fetch(url.toString(), { method: body === undefined ? 'GET' : 'POST',
            redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            throw new Error('USAspending returned a redirect; no alternate destination was fetched');
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`USAspending returned HTTP ${response.status}`);
        }
        if (!/application\/json/i.test(response.headers.get('content-type') || '')) {
            await response.body?.cancel();
            throw new Error('USAspending did not return JSON');
        }
        if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) {
            await response.body?.cancel();
            throw new Error('USAspending response exceeds the 2 MB collection limit');
        }
        if (!response.body)
            throw new Error('USAspending returned an empty response');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let total = 0, result = '';
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                total += chunk.value.byteLength;
                if (total > MAX_BYTES) {
                    await reader.cancel();
                    throw new Error('USAspending response exceeds the 2 MB collection limit');
                }
                result += decoder.decode(chunk.value, { stream: true });
            }
            const parsed = JSON.parse(result + decoder.decode());
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('USAspending response has an invalid shape');
            return parsed;
        }
        finally {
            reader.releaseLock();
        }
    }
    finally {
        clearTimeout(timer);
    }
}
function record(row, match, checkedAt) {
    const generatedId = text(row.generated_internal_id, 240), awardId = text(row['Award ID'], 160), actionDate = date(row['Action Date']);
    if (!/^(?:CONT_AWD|CONT_IDV)_[A-Za-z0-9_.-]+$/.test(generatedId) || !awardId || !actionDate)
        return null;
    // Search internal_id identifies the award, not its individual transactions.
    const transaction = { id: `${generatedId}:${text(row.Mod, 30) || '(no-mod)'}:${actionDate}`,
        actionDate, modification: text(row.Mod, 30), obligation: amount(row['Transaction Amount']), description: text(row['Transaction Description'], 4000),
        type: text(row['Award Type'], 100), actionType: text(row['Action Type'], 80) };
    return { id: `usa_${generatedId}`, company: match.target.company.name, recipient: text(row['Recipient Name'], 250), recipientUei: uei(row['Recipient UEI']),
        awardId, generatedId, agency: text(row['Awarding Agency'], 250), subAgency: text(row['Awarding Sub Agency'], 250), description: transaction.description,
        actionDate, startDate: '', endDate: '', obligations: null, ceiling: null, baseAndExercised: null,
        url: `https://www.usaspending.gov/award/${encodeURIComponent(generatedId)}`, fetchedAt: checkedAt, matchBasis: match.basis, mappingVerified: match.verified,
        detailAvailable: false, detailFetchedAt: '', transactions: [transaction], raw: { source: 'USAspending', endpoint: SEARCH_PATH, transaction: row } };
}
function detailSnapshot(award, data) {
    if (text(data.generated_unique_award_id, 240) !== award.generatedId)
        throw new Error('USAspending award detail identity did not match');
    const recipient = data.recipient && typeof data.recipient === 'object' ? data.recipient : {};
    const apiUei = uei(recipient.recipient_uei);
    if (apiUei && award.recipientUei && apiUei !== award.recipientUei)
        throw new Error('USAspending recipient identity changed; detail needs review');
    const period = data.period_of_performance && typeof data.period_of_performance === 'object' ? data.period_of_performance : {};
    award.obligations = amount(data.total_obligation);
    // These are separate API fields. Potential value is never substituted for funded obligations.
    award.ceiling = amount(data.base_and_all_options);
    award.baseAndExercised = amount(data.base_exercised_options);
    award.startDate = date(period.start_date);
    award.endDate = date(period.end_date);
    award.description = text(data.description, 4000) || award.description;
    award.detailAvailable = true;
    award.detailFetchedAt = award.fetchedAt;
    award.raw.detail = { generated_unique_award_id: data.generated_unique_award_id, piid: data.piid, date_signed: data.date_signed,
        total_obligation: data.total_obligation, base_and_all_options: data.base_and_all_options, base_exercised_options: data.base_exercised_options,
        description: award.description, period_of_performance: period,
        recipient: { recipient_name: recipient.recipient_name, recipient_uei: recipient.recipient_uei, parent_recipient_name: recipient.parent_recipient_name, parent_recipient_uei: recipient.parent_recipient_uei } };
}
/** Six batched searches plus at most two detail calls. Never exceeds eight HTTP requests, including failures. */
export async function collectOfficialAwards(companies, mappings = [], options = {}) {
    const instant = new Date(options.now || Date.now()), checkedAt = Number.isNaN(instant.getTime()) ? new Date().toISOString() : instant.toISOString();
    const day = checkedAt.slice(0, 10), windowDays = Math.min(90, Math.max(1, Math.floor(options.windowDays || 45)));
    const cutoff = new Date(Date.parse(checkedAt) - windowDays * 86400000).toISOString().slice(0, 10);
    const directory = targets(companies, mappings), groups = [];
    for (let index = 0; index < directory.length; index += 5)
        groups.push(directory.slice(index, index + 5));
    const result = { awards: [], health: [], checkedAt, limited: false };
    const indexed = new Map();
    // Two concurrent searches keep latency bounded without flooding the public source.
    const run = async (group, groupIndex) => {
        const source = `USAspending: ${group.map(target => target.company.name).join(', ')}`;
        try {
            const queryTerms = [...new Set(group.flatMap(target => [...target.terms, ...target.mappings.map(mapping => uei(mapping.uei)).filter(Boolean)]))];
            const data = await request(SEARCH_PATH, { filters: { award_type_codes: ['A', 'B', 'C', 'D'], recipient_search_text: queryTerms,
                    time_period: [{ start_date: cutoff, end_date: day }] }, fields: FIELDS, page: 1, limit: 100, sort: 'Action Date', order: 'desc' });
            if (!Array.isArray(data.results))
                throw new Error('USAspending response did not include transaction results');
            let matches = 0;
            for (const value of data.results.slice(0, 100)) {
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    continue;
                const row = value, match = identify(row, group);
                if (!match)
                    continue;
                const award = record(row, match, checkedAt);
                if (!award || award.actionDate < cutoff || award.actionDate > day)
                    continue;
                matches++;
                const existing = indexed.get(award.id);
                if (existing) {
                    for (const transaction of award.transactions)
                        if (!existing.transactions.some(item => item.id === transaction.id))
                            existing.transactions.push(transaction);
                    if (award.actionDate > existing.actionDate) {
                        existing.actionDate = award.actionDate;
                        existing.description = award.description;
                    }
                }
                else
                    indexed.set(award.id, award);
            }
            const metadata = data.page_metadata && typeof data.page_metadata === 'object' ? data.page_metadata : {};
            const limited = metadata.hasNext === true;
            if (limited)
                result.limited = true;
            result.health[groupIndex] = { source, status: limited ? 'warning' : 'ok', detail: `${matches} matched transaction rows from ${cutoff} to ${day}. ${limited ? 'First 100 source rows only; additional results require pagination.' : 'All returned rows checked.'} Recipient names without verified entity mappings require review; unrecognized subsidiaries are excluded.` };
        }
        catch (error) {
            result.limited = true;
            result.health[groupIndex] = { source, status: 'error', detail: error instanceof Error && error.name === 'AbortError' ? 'USAspending request timed out; saved awards remain available.' : text(error instanceof Error ? error.message : 'USAspending collection failed', 500) };
        }
    };
    for (let index = 0; index < groups.length; index += 2)
        await Promise.all(groups.slice(index, index + 2).map((group, offset) => run(group, index + offset)));
    const awards = [...indexed.values()].sort((a, b) => b.actionDate.localeCompare(a.actionDate) || a.id.localeCompare(b.id));
    const preferred = options.detailAwardIds || [];
    const detailTargets = [...awards].sort((a, b) => {
        const aIndex = preferred.indexOf(a.generatedId), bIndex = preferred.indexOf(b.generatedId);
        return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
    }).slice(0, 2);
    await Promise.all(detailTargets.map(async (award) => {
        try {
            detailSnapshot(award, await request(`/api/v2/awards/${encodeURIComponent(award.generatedId)}/`));
        }
        catch (error) {
            result.limited = true;
            result.health.push({ source: `USAspending detail: ${award.awardId}`, status: 'warning', detail: text(error instanceof Error ? error.message : 'Award detail unavailable', 500) });
        }
    }));
    for (const award of awards)
        award.transactions.sort((a, b) => b.actionDate.localeCompare(a.actionDate) || a.id.localeCompare(b.id));
    result.awards = awards;
    result.health.push({ source: 'USAspending collection scope', status: result.limited ? 'warning' : 'ok',
        detail: `Official contract actions for ${directory.length} competitor searches. Up to 6 batches of 100 transaction rows and 2 award detail lookups per refresh. Missing cumulative obligations, exercised value and potential ceiling stay unknown. Action dates reflect source transactions; snapshots are not labeled new awards. Name matching excludes subsidiaries until explicitly mapped. US federal prime contracts only; not complete procurement or teaming coverage.` });
    return result;
}
