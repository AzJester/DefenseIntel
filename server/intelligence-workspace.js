import { env } from '../hosting/runtime.mjs';
import { clusterEvents, normalizePreferences } from './event-intelligence.js';
import { collectOfficialAwards } from './official-awards.js';
import naicsCatalog from '../public/naics-2022.json' with { type: 'json' };
const database = () => { if (!env.DB)
    throw Error('Persistent database unavailable'); return env.DB; };
const stamp = () => new Date().toISOString();
const clean = (v, n = 2000) => String(v ?? '').trim().slice(0, n);
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function get(key, fallback = null) { const row = await database().prepare('SELECT value FROM metadata WHERE key=?').bind(key).first(); return row ? JSON.parse(row.value) : fallback; }
async function put(key, value) { await database().prepare('INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value)).run(); }
async function batches(statements) { for (let i = 0; i < statements.length; i += 75)
    await database().batch(statements.slice(i, i + 75)); }
async function bulk(table, columns, rows, suffix = '') { const statements = []; const per = Math.floor(90 / columns.length); for (let i = 0; i < rows.length; i += per) {
    const group = rows.slice(i, i + per);
    statements.push(database().prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${group.map(() => `(${columns.map(() => '?').join(',')})`).join(',')} ${suffix}`).bind(...group.flat()));
} await batches(statements); }
export async function captureSources(records, fetchedAt = stamp()) {
    const provenance = [], versions = [];
    for (const r of records) {
        const source = { id: r.id, company: r.company, title: r.title, summary: r.summary, url: r.url, published: r.published, category: r.category, source: r.source, verification: r.verification };
        const digest = await hash(JSON.stringify(source));
        provenance.push([r.id, fetchedAt, fetchedAt, digest]);
        versions.push([r.id + '-' + digest, r.id, fetchedAt, JSON.stringify(source)]);
    }
    await bulk('record_provenance', ['record_id', 'first_seen', 'fetched_at', 'hash'], provenance, 'ON CONFLICT(record_id) DO UPDATE SET fetched_at=excluded.fetched_at,hash=excluded.hash');
    await bulk('evidence_versions', ['id', 'record_id', 'fetched_at', 'data'], versions, 'ON CONFLICT(id) DO NOTHING');
}
export async function officialRecords() { const result = await database().prepare('SELECT data FROM official_awards ORDER BY published DESC LIMIT 500').all(); return result.results.map(r => JSON.parse(r.data)); }
export function awardEvidence(a) { const transactions = Array.isArray(a.transactions) ? a.transactions : [], t = [...transactions].sort((x, y) => String(y.actionDate).localeCompare(String(x.actionDate)))[0]; const money = (v) => typeof v === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v) : 'Not supplied'; return { id: 'official-' + a.id, company: a.company, title: `${a.company}: ${a.awardId || a.generatedId} contract action`, category: 'Contract action', summary: `${a.description || 'Official contract record'}. Recipient: ${a.recipient}. Agency: ${a.agency || 'Not supplied'}. Latest retrieved action: ${t?.actionDate || a.actionDate || 'Not supplied'}; modification: ${t?.modification || 'Not supplied'}; action obligation: ${money(t?.obligation)}. Cumulative obligations: ${money(a.obligations)}. Potential ceiling: ${money(a.ceiling)}. A contract action may modify an existing award.`, assessment: '', url: a.url, published: a.actionDate || '', date: a.actionDate || '', reviewed: '', fetchedAt: a.fetchedAt, firstSeen: a.firstSeen || a.fetchedAt, source: 'USAspending.gov', verification: 'Official award record; recipient relationship ' + (a.matchBasis || 'requires review'), priority: 'Normal', origin: 'official', awardId: a.awardId, generatedId: a.generatedId, agency: a.agency, obligations: a.obligations, ceiling: a.ceiling, transactions }; }
export async function refreshOfficial(companies) {
    const prior = await officialRecords();
    const detailAwardIds = [...prior].sort((a, b) => String(a.detailFetchedAt || '').localeCompare(String(b.detailFetchedAt || ''))).slice(0, 2).map(a => a.generatedId);
    const result = await collectOfficialAwards(companies, await get('entity_mappings', []), { detailAwardIds });
    return saveOfficial(result, companies.length, 'Hosted collector');
}
async function saveOfficial(result, companyCount, transport) { const old = new Map((await officialRecords()).map(a => [a.id, a])); result.awards = result.awards.map((a) => { const previous = old.get(a.id); if (!previous)
    return a; const transactions = [...new Map([...(previous.transactions || []), ...(a.transactions || [])].map(t => [t.id, t])).values()]; return { ...a, firstSeen: previous.firstSeen || previous.fetchedAt, transactions, ...(!a.detailAvailable && previous.detailAvailable ? { obligations: previous.obligations, ceiling: previous.ceiling, baseAndExercised: previous.baseAndExercised, startDate: previous.startDate, endDate: previous.endDate, detailAvailable: true, detailFetchedAt: previous.detailFetchedAt } : {}) }; }); await bulk('official_awards', ['id', 'company', 'published', 'fetched_at', 'data'], result.awards.map((a) => [a.id, a.company, a.actionDate || '', a.fetchedAt, JSON.stringify(a)]), 'ON CONFLICT(id) DO UPDATE SET company=excluded.company,published=excluded.published,fetched_at=excluded.fetched_at,data=excluded.data'); const run = { checkedAt: result.checkedAt, records: result.awards.length, limited: result.limited, health: result.health, companyCount, transport }; await put('official_run', run); return run; }
async function intelligenceRows() { const result = await database().prepare('SELECT i.*,p.fetched_at AS fetchedAt,p.first_seen AS firstSeen FROM intelligence i LEFT JOIN record_provenance p ON p.record_id=i.id ORDER BY i.published DESC LIMIT 1500').all(); const excluded = new Set(await get('quarantined_records', [])); return result.results.filter(r => !excluded.has(r.id)); }
export async function rebuildEvents(notify = true) {
    const [records, awards, prefs, previousRows] = await Promise.all([intelligenceRows(), officialRecords(), get('monitor_preferences', {}), database().prepare('SELECT data FROM event_clusters ORDER BY updated DESC LIMIT 2000').all()]);
    const previous = previousRows.results.map(r => JSON.parse(r.data));
    const events = clusterEvents(records, awards, normalizePreferences(prefs), previous);
    const byId = new Map(previous.map((e) => [e.id, e]));
    const rows = [];
    let newAlerts = 0;
    const alertRecordIds = [];
    const at = stamp();
    for (const event of events) {
        rows.push([event.id, at, JSON.stringify(event)]);
        const old = byId.get(event.id);
        const recent = Date.parse(event.published || event.lastSeen || '') >= Date.now() - 15 * 86400000;
        const eligible = event.alertEligible && recent;
        const material = old && old.materialFingerprint !== event.materialFingerprint;
        if (eligible && (!old || material)) {
            const id = 'event-' + event.id + '-' + (await hash(event.materialFingerprint || event.title)).slice(0, 16);
            const severity = event.category === 'Acquisition' || event.relevanceScore >= 60 ? 'High' : 'Normal';
            const result = await database().prepare('INSERT OR IGNORE INTO event_alerts (id,event_id,severity,reason,created,acknowledged) VALUES (?,?,?,?,?,0)').bind(id, event.id, severity, `${material ? 'Material event change' : 'New event'}: ${(event.relevanceReasons || []).join('; ') || event.category}`, at).run();
            if (result.meta.changes && notify && previous.length) {
                newAlerts++;
                alertRecordIds.push(...(event.recordIds || []).slice(0, 1));
            }
        }
    }
    await bulk('event_clusters', ['id', 'updated', 'data'], rows, 'ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data');
    await put('active_event_ids', events.map(e => e.id));
    await put('events_ready', true);
    return { events: events.length, newAlerts, alertRecordIds };
}
export async function enhancedWorkspace(records) {
    if (!await get('events_ready', false))
        await rebuildEvents(false);
    const [awards, prefs, entities, findings, snapshotRows, eventRows, alerts, provenance, officialRun] = await Promise.all([officialRecords(), get('monitor_preferences', {}), get('entity_mappings', []), get('analyst_findings', []), database().prepare('SELECT id,title,created FROM brief_snapshots ORDER BY created DESC LIMIT 30').all(), database().prepare('SELECT data FROM event_clusters ORDER BY updated DESC LIMIT 2000').all(), database().prepare('SELECT * FROM event_alerts ORDER BY created DESC LIMIT 300').all(), database().prepare('SELECT * FROM record_provenance').all(), get('official_run')]);
    const active = new Set(await get('active_event_ids', eventRows.results.map(r => JSON.parse(r.data).id)));
    const sources = new Map(provenance.results.map((p) => [p.record_id, p]));
    const events = eventRows.results.map(r => JSON.parse(r.data)).filter(e => active.has(e.id));
    const visible = new Map(events.map((e) => [e.id, e]));
    return { records: [...records.map(r => ({ ...r, reviewed: r.origin === 'automatic' ? '' : r.reviewed, fetchedAt: sources.get(r.id)?.fetched_at || null, firstSeen: sources.get(r.id)?.first_seen || r.created || null })), ...awards.map(awardEvidence)], awards, events, preferences: normalizePreferences(prefs), entities, findings, workshops: await get('strategy_workshops', []), pursuits: await get('contract_pursuits', []), capturePlans: await get('capture_plans', []), snapshots: snapshotRows.results, eventAlerts: alerts.results.filter(a => visible.get(a.event_id)?.alertEligible).map(a => ({ ...a, event: visible.get(a.event_id) })), officialRun };
}
export async function enhancementMutation(body) {
    if (body.action === 'capture_plan') {
        const input = body.plan;
        if (!input || typeof input !== 'object')
            throw Error('A capture plan is required.');
        const pursuits = await get('contract_pursuits', []);
        const pursuitId = clean(input.pursuitId, 100);
        if (pursuitId && !pursuits.some((p) => p.id === pursuitId))
            throw Error('Choose an existing pursuit.');
        const available = new Set([...(await intelligenceRows()).map(r => r.id), ...(await officialRecords()).map(a => 'official-' + a.id)]);
        const table = (name, keys, max) => Array.isArray(input[name]) ? input[name].slice(0, max).map((r) => Object.fromEntries(keys.map(k => { if (k === 'evidenceIds') {
            const ids = Array.isArray(r[k]) ? [...new Set(r[k].map((v) => clean(v, 160)))].slice(0, 30) : [];
            if (ids.some(id => !available.has(id)))
                throw Error('A capture plan cites unavailable evidence.');
            return [k, ids];
        } return [k, clean(r[k], 3000)]; }))) : [];
        const url = clean(input.solicitationUrl, 2000);
        if (url) {
            const target = new URL(url);
            if (!['https:', 'http:'].includes(target.protocol))
                throw Error('Use a valid solicitation source link.');
        }
        const workshops = await get('strategy_workshops', []);
        const plan = { id: clean(input.id, 100) || crypto.randomUUID(), pursuitId, title: clean(input.title, 140), customerNeed: clean(input.customerNeed, 6000), programContext: clean(input.programContext, 10000), solicitationId: clean(input.solicitationId, 180), solicitationUrl: url, vehicle: clean(input.vehicle, 240), deadline: clean(input.deadline, 100), customerPriorities: clean(input.customerPriorities, 8000), requirements: table('requirements', ['requirement', 'evaluation', 'proof', 'owner', 'status', 'evidenceIds'], 50), stakeholders: table('stakeholders', ['role', 'need', 'engagement', 'owner'], 30), winThemes: table('winThemes', ['theme', 'customerBenefit', 'differentiator', 'proof', 'competitorContrast', 'confidence', 'evidenceIds'], 20), teaming: table('teaming', ['partner', 'role', 'rationale', 'gap', 'status'], 30), risks: table('risks', ['risk', 'impact', 'mitigation', 'owner', 'status'], 30), milestones: table('milestones', ['name', 'date', 'owner', 'status'], 40), gates: table('gates', ['name', 'decision', 'rationale', 'date', 'owner'], 20), blueTeam: table('blueTeam', ['question', 'finding', 'recommendation', 'owner', 'status', 'evidenceIds'], 40), notes: clean(input.notes, 20000), linkedWorkshopIds: Array.isArray(input.linkedWorkshopIds) ? [...new Set(input.linkedWorkshopIds.map((v) => clean(v, 100)))].filter(id => workshops.some((w) => w.id === id)).slice(0, 30) : [], updatedAt: stamp() };
        if (!plan.title)
            throw Error('Give the capture plan a title.');
        const rows = await get('capture_plans', []), next = rows.filter((p) => p.id !== plan.id);
        next.unshift(plan);
        if (next.length > 30)
            throw Error('Maximum 30 capture plans.');
        await put('capture_plans', next);
        return { ok: true, plan };
    }
    if (body.action === 'official_import') {
        const result = body.collection;
        if (!result || !Array.isArray(result.awards) || result.awards.length > 500 || !Array.isArray(result.health) || result.health.length > 30 || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) || Date.parse(result.checkedAt) > Date.now() + 300000)
            throw Error('Invalid official collection.');
        const directory = await database().prepare('SELECT name FROM competitors WHERE active=1').all();
        const allowed = new Set(directory.results.map(c => c.name));
        for (const a of result.awards) {
            if (!a || !['id', 'company', 'recipient', 'recipientUei', 'awardId', 'generatedId', 'agency', 'subAgency', 'description', 'actionDate', 'startDate', 'endDate', 'url', 'fetchedAt', 'matchBasis', 'detailFetchedAt'].every(k => typeof a[k] === 'string') || !allowed.has(a.company) || a.id.length > 250 || a.description.length > 10000 || !Array.isArray(a.transactions) || a.transactions.length > 100)
                throw Error('Invalid official award.');
            const link = new URL(a.url);
            if (link.origin !== 'https://www.usaspending.gov' || !link.pathname.startsWith('/award/'))
                throw Error('Official award source must be USAspending.gov.');
            if (['obligations', 'ceiling', 'baseAndExercised'].some(k => a[k] !== null && (typeof a[k] !== 'number' || !Number.isFinite(a[k]))))
                throw Error('Invalid award amounts.');
            if (!Number.isFinite(Date.parse(a.fetchedAt)) || Date.parse(a.fetchedAt) > Date.now() + 300000 || a.actionDate && (!Number.isFinite(Date.parse(a.actionDate)) || Date.parse(a.actionDate) > Date.now() + 300000))
                throw Error('Invalid official source date.');
            for (const t of a.transactions)
                if (!t || !['id', 'actionDate', 'modification', 'description', 'type', 'actionType'].every(k => typeof t[k] === 'string') || t.obligation !== null && (typeof t.obligation !== 'number' || !Number.isFinite(t.obligation)))
                    throw Error('Invalid contract action.');
        }
        const run = await saveOfficial(result, directory.results.length, 'External public-source collector');
        const grouped = await rebuildEvents();
        return { ok: true, official: run, ...grouped };
    }
    if (body.action === 'pursuit') {
        const input = body.pursuit;
        if (!input || typeof input !== 'object')
            throw Error('A pursuit is required.');
        const directory = await database().prepare('SELECT name FROM competitors').all();
        const names = new Set(['Our team', ...directory.results.map(c => c.name)]);
        const competitors = Array.isArray(input.competitors) ? [...new Set(input.competitors.map((c) => clean(c, 100)))].filter((c) => names.has(c)).slice(0, 31) : [];
        const criteria = Array.isArray(input.criteria) ? input.criteria.slice(0, 12).map((c) => ({ id: clean(c.id, 100) || crypto.randomUUID(), name: clean(c.name, 140), weight: Number(c.weight) })) : [];
        if (!criteria.length || criteria.some((c) => !c.name || !Number.isFinite(c.weight) || c.weight < 0 || c.weight > 1000) || !criteria.some((c) => c.weight > 0) || new Set(criteria.map((c) => c.id)).size !== criteria.length)
            throw Error('Use 1–12 named criteria with unique IDs and positive total weight.');
        const available = new Set([...(await intelligenceRows()).map(r => r.id), ...(await officialRecords()).map(a => 'official-' + a.id)]);
        const assessments = Array.isArray(input.assessments) ? input.assessments.slice(0, 372).map((a) => ({ company: clean(a.company, 100), criterionId: clean(a.criterionId, 100), score: a.score === null || a.score === undefined || a.score === '' ? null : Number(a.score), evidenceIds: Array.isArray(a.evidenceIds) ? [...new Set(a.evidenceIds.map((v) => clean(v, 160)))].slice(0, 30) : [], note: clean(a.note, 3000) })).filter((a) => competitors.includes(a.company) && criteria.some((c) => c.id === a.criterionId)) : [];
        if (assessments.some((a) => a.score !== null && (!Number.isFinite(a.score) || a.score < 0 || a.score > 5)))
            throw Error('Assessment scores must be 0–5 or unknown.');
        if (assessments.some((a) => a.evidenceIds.some((id) => !available.has(id))))
            throw Error('An assessment cites unavailable evidence.');
        const pairs = new Set();
        if (assessments.some((a) => { const key = a.company + '|' + a.criterionId; if (pairs.has(key))
            return true; pairs.add(key); return false; }))
            throw Error('Use one assessment for each company and criterion.');
        const pursuit = { id: clean(input.id, 100) || crypto.randomUUID(), title: clean(input.title, 140), naicsCodes: Array.isArray(input.naicsCodes) ? [...new Set(input.naicsCodes.map((v) => clean(v, 12)))].filter(code => naicsCatalog.codes.some(c => c.code === code)).slice(0, 20) : [], naicsVersion: naicsCatalog.metadata.version, customer: clean(input.customer, 180), program: clean(input.program, 240), stage: clean(input.stage, 80), value: input.value === null || input.value === '' || input.value === undefined ? null : Number(input.value), closeDate: clean(input.closeDate, 10), competitors, criteria, assessments, notes: clean(input.notes, 16000), updatedAt: stamp() };
        if (!pursuit.title || pursuit.value !== null && (!Number.isFinite(pursuit.value) || pursuit.value < 0))
            throw Error('A pursuit needs a title and a valid nonnegative value when supplied.');
        const rows = await get('contract_pursuits', []), next = rows.filter((p) => p.id !== pursuit.id);
        next.unshift(pursuit);
        if (next.length > 30)
            throw Error('Maximum 30 saved pursuits.');
        await put('contract_pursuits', next);
        return { ok: true, pursuit };
    }
    if (body.action === 'workshop') {
        const input = body.session;
        if (!input || typeof input !== 'object')
            throw Error('A workshop session is required.');
        const directory = await database().prepare('SELECT name FROM competitors').all();
        const names = new Set(directory.results.map(c => c.name));
        const available = new Set([...(await intelligenceRows()).map(r => r.id), ...(await officialRecords()).map(a => 'official-' + a.id)]);
        const citations = (v) => Array.isArray(v) ? [...new Set(v.map((id) => clean(id, 160)))].slice(0, 80) : [];
        const evidenceIds = citations(input.evidenceIds);
        if (evidenceIds.some(id => !available.has(id)))
            throw Error('A workshop evidence record is unavailable.');
        const textRows = (v, keys, limit = 30) => Array.isArray(v) ? v.slice(0, limit).map(row => Object.fromEntries(keys.map(key => [key, key === 'evidenceIds' ? citations(row[key]).filter(id => evidenceIds.includes(id)) : clean(row[key], key === 'notes' ? 6000 : 2000)]))) : [];
        const session = { id: clean(input.id, 100) || crypto.randomUUID(), title: clean(input.title, 140), type: ['Capture black hat', 'Blue team review'].includes(input.type) ? input.type : 'Strategy session', objective: clean(input.objective, 3000), customer: clean(input.customer, 180), opportunity: clean(input.opportunity, 300), competitors: Array.isArray(input.competitors) ? input.competitors.map((c) => clean(c, 100)).filter((c) => names.has(c)).slice(0, 30) : [], evidenceIds, hypotheses: textRows(input.hypotheses, ['competitor', 'claim', 'basis', 'confidence', 'evidenceIds']), decisions: textRows(input.decisions, ['decision', 'rationale', 'evidenceIds']), actions: textRows(input.actions, ['action', 'owner', 'due', 'status']), notes: clean(input.notes, 20000), roleNotes: clean(input.roleNotes, 12000), updatedAt: stamp() };
        if (!session.title || !session.objective)
            throw Error('A session needs a title and objective.');
        const rows = await get('strategy_workshops', []);
        const next = rows.filter((s) => s.id !== session.id);
        next.unshift(session);
        if (next.length > 50)
            throw Error('Maximum 50 saved sessions.');
        await put('strategy_workshops', next);
        return { ok: true, session };
    }
    if (body.action === 'preferences') {
        const preferences = normalizePreferences(body.preferences);
        await put('monitor_preferences', preferences);
        await rebuildEvents(false);
        return { ok: true, preferences };
    }
    if (body.action === 'entity') {
        const rows = await get('entity_mappings', []), company = clean(body.company, 100), name = clean(body.name, 150), uei = clean(body.uei, 12).toUpperCase(), cage = clean(body.cage, 5).toUpperCase();
        if (!company || !name)
            throw Error('Choose a competitor and legal recipient name.');
        if (uei && !/^[A-Z0-9]{12}$/.test(uei))
            throw Error('A UEI must contain 12 letters or numbers.');
        if (cage && !/^[A-Z0-9]{5}$/.test(cage))
            throw Error('A CAGE code must contain 5 letters or numbers.');
        const exists = await database().prepare('SELECT id FROM competitors WHERE name=?').bind(company).first();
        if (!exists)
            throw Error('Unknown competitor.');
        const row = { id: clean(body.id, 100) || 'entity-' + (await hash(company + '|' + name + '|' + uei)).slice(0, 24), company, name, uei, cage, verified: body.verified === true, updatedAt: stamp() };
        const next = rows.filter((r) => r.id !== row.id);
        next.push(row);
        if (next.length > 250)
            throw Error('Maximum 250 recipient mappings.');
        await put('entity_mappings', next);
        return { ok: true, entity: row };
    }
    if (body.action === 'finding') {
        const rows = await get('analyst_findings', []);
        const row = { id: clean(body.id, 100) || crypto.randomUUID(), change: clean(body.change), implication: clean(body.implication), action: clean(body.recommendedAction || body.nextAction), confidence: ['Low', 'Moderate', 'High'].includes(body.confidence) ? body.confidence : 'Low', evidenceIds: Array.isArray(body.evidenceIds) ? [...new Set(body.evidenceIds.map((v) => clean(v, 160)))].slice(0, 30) : [], owner: clean(body.owner, 100), due: clean(body.due, 10), updatedAt: stamp(), archived: body.archived === true };
        if (!row.change || !row.implication || !row.action || !row.evidenceIds.length)
            throw Error('A finding needs a change, implication, next action and evidence.');
        const available = new Set([...(await intelligenceRows()).map(r => r.id), ...(await officialRecords()).map(a => 'official-' + a.id)]);
        if (row.evidenceIds.some(id => !available.has(id)))
            throw Error('A cited evidence record is unavailable.');
        const next = rows.filter((r) => r.id !== row.id);
        next.push(row);
        if (next.length > 200)
            throw Error('Maximum 200 findings.');
        await put('analyst_findings', next);
        return { ok: true, finding: row };
    }
    if (body.action === 'ack_event') {
        await database().prepare('UPDATE event_alerts SET acknowledged=1 WHERE event_id=?').bind(clean(body.eventId, 160)).run();
        return { ok: true };
    }
    if (body.action === 'snapshot_get') {
        const row = await database().prepare('SELECT data FROM brief_snapshots WHERE id=?').bind(clean(body.id, 100)).first();
        if (!row)
            throw Error('Snapshot not found.');
        return { ok: true, snapshot: JSON.parse(row.data) };
    }
    if (body.action === 'brief_snapshot') {
        const supplied = body.options;
        if (!supplied || !Array.isArray(supplied.records) || supplied.records.length > 1000)
            throw Error('Select up to 1,000 evidence records.');
        const selected = new Set(supplied.records.map((r) => r.id));
        if (selected.size !== supplied.records.length)
            throw Error('Evidence record IDs must be unique.');
        if (!selected.size && !supplied.ov1)
            throw Error('Choose evidence or an operational concept.');
        const findings = Array.isArray(supplied.findings) ? supplied.findings.slice(0, 200) : [];
        if (findings.some((f) => !Array.isArray(f.evidenceIds) || !f.evidenceIds.length || f.evidenceIds.some((id) => !selected.has(id))))
            throw Error('Every finding must cite evidence in the selected report.');
        const generatedAt = stamp(), snapshotId = crypto.randomUUID();
        const snapshot = { ...supplied, title: clean(supplied.title, 140) || 'Decision brief', findings, generatedAt, snapshotId, snapshotVersion: 1 };
        const data = JSON.stringify(snapshot);
        if (data.length > 1500000)
            throw Error('Brief snapshot is too large. Narrow the report selection.');
        await database().prepare('INSERT INTO brief_snapshots (id,title,created,data) VALUES (?,?,?,?)').bind(snapshotId, snapshot.title, generatedAt, data).run();
        return { ok: true, options: snapshot };
    }
    return null;
}
