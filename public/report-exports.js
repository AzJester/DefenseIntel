/* Browser exports. No network requests; supplied evidence and user-authored models only. */
(function (root) {
  'use strict';
  const C = { navy: '0B1F35', blue: '003E73', gold: 'C5A04E', ink: '172B3D', muted: '536574', pale: 'F1F5F8', white: 'FFFFFF' };
  const FONT = 'Arial';
  const DRAFT = 'CONCEPT DRAFT • Validate operational relationships';
  const clean = value => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const esc = value => clean(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (value, limit) => {
    const text = clean(value).replace(/\s+/g, ' ').trim();
    return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
  };
  const url = value => {
    try { const parsed = new URL(clean(value)); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : ''; }
    catch (_) { return ''; }
  };
  const stamp = () => new Date().toISOString();
  const filename = title => short(title, 100).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/\s+/g, '-').replace(/[.\s-]+$/g, '') || 'competitive-intelligence';
  const list = values => Array.isArray(values) ? values : [];
  const paragraphs = value => esc(value).replace(/\r?\n/g, '<br>');
  function record(value, index) {
    const item = value && typeof value === 'object' ? value : {};
    return {
      n: index + 1, id: clean(item.id) || 'record-' + (index + 1), title: clean(item.title) || 'Untitled evidence record', company: clean(item.company) || 'Unspecified company',
      category: clean(item.category) || 'Evidence', summary: clean(item.summary || item.evidence) || 'No evidence text supplied.',
      assessment: clean(item.assessment), date: clean(item.date || item.publishedAt || item.published),
      reviewed: clean(item.reviewed), fetchedAt: clean(item.fetchedAt || item.retrievedAt), priority: clean(item.priority),
      source: url(item.url || item.sourceUrl || item.link), rawSource: clean(item.url || item.sourceUrl || item.link),
      confidence: clean(item.confidence), sourceName: clean(item.sourceName || item.publisher || item.source),
      verification: clean(item.verification || item.status), original: JSON.parse(JSON.stringify(item))
    };
  }
  const records = values => list(values).map(record);
  const companyNames = values => list(values).map(value => clean(typeof value === 'string' ? value : value && value.name)).filter(Boolean);
  function refs(values, items, context, required) {
    const ids = [...new Set(list(values).map(clean).filter(Boolean))];
    if (required && !ids.length) throw new Error(context + ' needs at least one selected evidence record.');
    return ids.map(id => {
      const item = items.find(value => value.id === id);
      if (!item) throw new Error(context + ' references an evidence record outside this selection: ' + id);
      return item;
    });
  }
  function context(options) {
    const data = options || {}, items = records(data.records);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Evidence record IDs must be unique within an export.');
    const generatedAt = clean(data.generatedAt) || stamp();
    if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('The report generation timestamp is invalid.');
    const snapshotId = clean(data.snapshotId) || 'CI-' + generatedAt.replace(/[^0-9]/g, '');
    const findings = list(data.findings).map((finding, index) => {
      const f = finding || {}, evidence = refs(f.evidenceIds, items, 'Finding ' + (index + 1), true);
      return { n: index + 1, change: clean(f.change), implication: clean(f.implication), action: clean(f.action), confidence: clean(f.confidence) || 'Not supplied', evidenceIds: evidence.map(item => item.id), evidence, owner: clean(f.owner), due: clean(f.due) };
    });
    return { data, items, findings, generatedAt, snapshotId, title: clean(data.title) || 'Competitive intelligence report', template: clean(data.template) || 'Decision brief' };
  }
  const citeText = evidence => evidence.map(item => '[' + item.n + ']').join(', ');
  const citeHtml = evidence => evidence.map(item => `<a href="#record-${item.n}">[${item.n}] ${esc(item.company)}</a>`).join('; ');
  function findingNotes(finding) {
    return `Finding ${finding.n}\nReported change: ${finding.change || 'Not supplied'}\nAnalyst inference / implication: ${finding.implication || 'Not supplied'}\nProposed action: ${finding.action || 'Not supplied'}\nAnalyst-supplied confidence: ${finding.confidence}\nOwner: ${finding.owner || 'Not assigned'}\nDue: ${finding.due || 'Not assigned'}\nEvidence references: ${citeText(finding.evidence)}\n\n${finding.evidence.map(sourceNotes).join('\n\n')}`;
  }
  async function snapshot(options) {
    const c = context(options);
    if (!c.items.length && !c.data.ov1) throw new Error('Select evidence records or supply an operational concept for a snapshot.');
    const concept = c.data.ov1 ? model(Object.assign({}, c.data.ov1, { records: c.data.records })) : null;
    const payload = {
      workshop: c.data.workshop || null, capturePlan: c.data.capturePlan || null, pursuit: c.data.pursuit || null, schema: 'competitive-intelligence-evidence-snapshot', version: 1, snapshotId: c.snapshotId, generatedAt: c.generatedAt,
      title: c.title, template: c.template, companies: JSON.parse(JSON.stringify(list(c.data.companies))),
      findings: c.findings.map(({ evidence, ...finding }) => finding),
      records: c.items.map(item => Object.assign({}, item.original, { id: item.id, published: item.date, fetchedAt: item.fetchedAt, reviewed: item.reviewed })),
      events: JSON.parse(JSON.stringify(list(c.data.events))),
      ov1: concept ? Object.assign({}, c.data.ov1, { records: undefined, validationStatus: concept.validationStatus, validationWarnings: concept.validationWarnings }) : null,
      provenance: { scope: 'Selected workspace evidence at export time', retrievalMeaning: 'fetchedAt is collection time; reviewed is analyst review time. Missing timestamps remain blank.', confidenceMeaning: 'Confidence and implications are analyst supplied. No independent source verification is implied.', sourceContent: 'Stored record text and links only. Linked pages are not archived by this snapshot.' }
    };
    return Object.assign(download(filename(c.title) + '-evidence-snapshot.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8'), { snapshotId: c.snapshotId, records: c.items.length });
  }
  function download(name, data, type) {
    if (!root.document || !root.URL || typeof root.URL.createObjectURL !== 'function') throw new Error('Downloads require a browser.');
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const objectUrl = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement('a');
    anchor.href = objectUrl; anchor.download = name; anchor.rel = 'noopener';
    anchor.style.display = 'none'; root.document.body.appendChild(anchor); anchor.click(); anchor.remove();
    root.setTimeout(() => root.URL.revokeObjectURL(objectUrl), 30000);
    return { fileName: name, bytes: blob.size };
  }
  function sourceNotes(item) {
    return [
      `[${item.n}] ${item.title}`, `Company: ${item.company}`, `Category: ${item.category}`,
      `Evidence ID: ${item.id}`, `Publication date: ${item.date || 'Not supplied'}`, `Retrieved: ${item.fetchedAt || 'Not supplied'}`, `Analyst reviewed: ${item.reviewed || 'Not supplied'}`,
      `Priority: ${item.priority || 'Not assigned'}`, `Evidence:\n${item.summary}`,
      `Analyst assessment:\n${item.assessment || 'No assessment supplied.'}`,
      `Source: ${item.source || item.rawSource || 'No source URL supplied.'}`,
      item.confidence ? `Supplied confidence: ${item.confidence}` : '',
      item.verification ? `Supplied verification status: ${item.verification}` : '',
      'The export reproduces supplied records. Source links and assessments require analyst review.'
    ].filter(Boolean).join('\n\n');
  }

  async function report(options) {
    const c = context(options), data = c.data, title = c.title;
    const items = c.items, companies = companyNames(data.companies), generated = c.generatedAt;
    if (!items.length) throw new Error('Select at least one evidence record for a report.');
    const concept = data.ov1 ? model(Object.assign({}, data.ov1, { records: data.records })) : null;
    const decisionSummary = `<section><h2>Decision summary</h2><p class="meta">${esc(c.template)} · Snapshot ${esc(c.snapshotId)}. Implications, actions and confidence below are analyst supplied.</p>${c.findings.length ? c.findings.map(finding => `<article><h3>${finding.n}. Reported change</h3><p>${paragraphs(finding.change || 'Not supplied.')}</p><p>Evidence: ${citeHtml(finding.evidence)}</p><div class="assessment"><h3>Why it matters: analyst inference</h3><p>${paragraphs(finding.implication || 'No implication supplied.')}</p><h3>Recommended action</h3><p>${paragraphs(finding.action || 'No action supplied.')}</p><p class="meta">Analyst-supplied confidence: ${esc(finding.confidence)} · Owner: ${esc(finding.owner || 'Not assigned')} · Due: ${esc(finding.due || 'Not assigned')}</p></div></article>`).join('') : '<p>No analyst decision findings supplied. The evidence register below preserves the selected source records.</p>'}</section>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(title)}</title><style>
      :root{font-family:Arial,Helvetica,sans-serif;color:#${C.ink};background:#${C.white};font-size:16px;line-height:1.55}body{max-width:1000px;margin:0 auto;padding:48px}header{border-top:10px solid #${C.navy};border-bottom:3px solid #${C.gold};padding:24px 0}h1{font-size:34px;line-height:1.2;color:#${C.navy};margin:0 0 12px}h2{font-size:24px;line-height:1.3;color:#${C.navy}}h3{font-size:17px;color:#${C.blue};margin:22px 0 6px}p{margin:8px 0}a{color:#${C.blue};overflow-wrap:anywhere}article{padding:22px 0;border-bottom:1px solid #cdd7de;break-inside:avoid}.meta{color:#${C.muted};font-size:14px}.label{font-weight:bold}.assessment{border-left:3px solid #${C.gold};padding-left:18px}.notice{background:#${C.pale};padding:16px 20px;margin:22px 0}svg{max-width:100%;height:auto}.sources{padding-left:24px}.sources li{padding:8px 0;overflow-wrap:anywhere}.print-tip{font-size:14px;color:#${C.muted}}@media print{body{padding:0;max-width:none;font-size:11pt}h1{font-size:24pt}article{break-inside:auto}h2,h3{break-after:avoid}.print-tip{display:none}a{color:inherit}header{padding-top:15px}@page{margin:18mm}}
      </style></head><body><header><h1>${esc(title)}</h1><p class="meta">Generated ${esc(generated)} · ${items.length} evidence record${items.length === 1 ? '' : 's'} · Snapshot ${esc(c.snapshotId)}</p>${companies.length ? `<p>Company scope: ${esc(companies.join(', '))}</p>` : ''}</header><p class="print-tip">Open this downloaded report in your browser. Use Print to save a PDF. Download the matching JSON evidence snapshot from the workspace to preserve the complete selected records.</p><div class="notice">Source record text may be a publisher or feed excerpt. The workspace does not independently confirm its claims. Implications and recommended actions are analyst inference, and confidence is analyst supplied. Publication, collection and analyst review timestamps are separate. Linked pages may change after this frozen export.</div>
      ${decisionSummary}
      ${concept ? `<section><h2>Operational concept</h2><p class="meta">${esc(concept.validationLabel)} · ${esc(concept.validationNotes || 'No analyst validation notes supplied.')}</p>${concept.validationWarnings.length ? `<p>${esc(concept.validationWarnings.join(' '))}</p>` : ''}${ov1(Object.assign({}, data.ov1, { records: data.records }))}<p>Linked evidence: ${concept.evidence.length ? citeHtml(concept.evidence) : 'None supplied.'}</p></section>` : ''}
      <section><h2>Evidence register</h2>${items.map(item => `<article id="record-${item.n}"><p class="meta">[${item.n}] ${esc(item.company)} · ${esc(item.category)}${item.priority ? ` · Supplied priority: ${esc(item.priority)}` : ''}</p><h2>${esc(item.title)}</h2><p class="meta">Evidence ID: ${esc(item.id)}<br>Published: ${esc(item.date || 'Not supplied')} · Retrieved: ${esc(item.fetchedAt || 'Not supplied')} · Analyst reviewed: ${esc(item.reviewed || 'Not supplied')}</p><h3>Source record text</h3><p>${paragraphs(item.summary)}</p><div class="assessment"><h3>Analyst assessment / inference</h3><p>${paragraphs(item.assessment || 'No assessment supplied.')}</p>${item.confidence ? `<p class="meta">Analyst-supplied confidence: ${esc(item.confidence)}</p>` : ''}</div><p>${item.source ? `<a href="${esc(item.source)}" target="_blank" rel="noopener noreferrer">[${item.n}] ${esc(item.sourceName || 'Read source')}</a>` : 'No valid public source URL supplied.'}</p>${item.verification ? `<p class="meta">Supplied verification status: ${esc(item.verification)}</p>` : ''}</article>`).join('')}</section>
      <section><h2>Source register</h2><ol class="sources">${items.map(item => `<li><strong>${esc(item.title)}</strong><br>${item.source ? `<a href="${esc(item.source)}" target="_blank" rel="noopener noreferrer">${esc(item.source)}</a>` : esc(item.rawSource || 'No source URL supplied.')}<br><span class="meta">Publication date: ${esc(item.date || 'Not supplied')} · Retrieved: ${esc(item.fetchedAt || 'Not supplied')} · Analyst reviewed: ${esc(item.reviewed || 'Not supplied')}</span></li>`).join('')}</ol></section><footer class="meta">Snapshot ${esc(c.snapshotId)} · Generated from the workspace selection at ${esc(generated)}. The JSON snapshot preserves stored evidence text and links; it does not archive linked pages.</footer></body></html>`;
    return Object.assign(download(filename(title) + '.html', html, 'text/html;charset=utf-8'), { snapshotId: c.snapshotId, findings: c.findings.length });
  }

  function lines(value) {
    return (Array.isArray(value) ? value.map(v => typeof v === 'object' && v ? v.label || v.name || v.title || '' : v) : clean(value).split(/\r?\n/)).map(v => clean(v).trim()).filter(Boolean);
  }
  function wrap(value, width, limit) {
    const text = clean(value).trim();
    if (!text) return [];
    const words = text.split(/\s+/), result = [];
    let current = '';
    for (const word of words) {
      if (current && (current + ' ' + word).length > width) { result.push(current); current = ''; }
      let remainder = word;
      while (remainder.length > width) { if (current) { result.push(current); current = ''; } result.push(remainder.slice(0, width)); remainder = remainder.slice(width); }
      current = current ? current + ' ' + remainder : remainder;
    }
    if (current) result.push(current);
    return result.length <= limit ? result : result.slice(0, limit - 1).concat(short(result.slice(limit - 1).join(' '), width));
  }
  function model(value) {
    const input = value && typeof value === 'object' ? value : {};
    const actors = lines(input.actors), activities = lines(input.activities), evidenceItems = records(input.records);
    if (new Set(evidenceItems.map(item => item.id)).size !== evidenceItems.length) throw new Error('Operational concept evidence IDs must be unique.');
    const evidence = refs(input.evidenceIds, evidenceItems, 'Operational concept', false);
    const nodeDetails = values => Array.isArray(values) ? values : lines(values);
    const node = (entry, type, index, x) => {
      const detail = entry && typeof entry === 'object' ? entry : {};
      const linked = refs(detail.evidenceIds, evidenceItems, 'Operational participant or activity ' + (index + 1), false);
      return { id: clean(detail.id) || type + (index + 1), label: clean(typeof entry === 'object' ? entry.label || entry.name || entry.title : entry), x, y: 245 + index * 76, w: 250, h: 64, evidence: linked, validationStatus: clean(detail.validationStatus), validationNotes: clean(detail.validationNotes) };
    };
    const nodes = [];
    nodeDetails(input.actors).slice(0, 4).forEach((entry, index) => nodes.push(node(entry, 'actor', index, 48)));
    nodeDetails(input.activities).slice(0, 4).forEach((entry, index) => nodes.push(node(entry, 'activity', index, 475)));
    if (clean(input.outcome).trim()) nodes.push({ id: 'outcome', label: clean(input.outcome).trim(), x: 902, y: 330, w: 250, h: 120, evidence: [] });
    if (new Set(nodes.map(value => value.id.toLowerCase())).size !== nodes.length) throw new Error('Operational participants and activities need unique node IDs.');
    const find = value => { const key = clean(value).trim().toLowerCase(); return nodes.find(node => node.id.toLowerCase().replace(/[-_\s]/g, '') === key.replace(/[-_\s]/g, '') || node.label.toLowerCase() === key); };
    const raw = Array.isArray(input.exchanges) ? input.exchanges : lines(input.exchanges);
    const exchanges = [], unresolved = [];
    raw.forEach(value => {
      let spec = value;
      if (typeof value === 'string') {
        const match = value.match(/^(.+?)\s*(?:->|→)\s*([^:]+)(?::\s*(.*))?$/);
        spec = match ? { from: match[1], to: match[2], label: match[3] || '' } : null;
      }
      const from = spec && find(spec.from), to = spec && find(spec.to);
      const linked = spec ? refs(spec.evidenceIds, evidenceItems, 'Operational exchange', false) : [];
      if (from && to && from.id !== to.id) exchanges.push({ from, to, label: clean(spec.label || spec.name || 'User-supplied exchange'), evidence: linked, validationStatus: clean(spec.validationStatus), validationNotes: clean(spec.validationNotes) });
      else unresolved.push(typeof value === 'string' ? value : JSON.stringify(value));
    });
    const allEvidence = [...new Map(evidence.concat(nodes.flatMap(value => value.evidence || []), exchanges.flatMap(value => value.evidence || [])).map(item => [item.id, item])).values()];
    const validationNotes = clean(input.validationNotes), declaredValidated = clean(input.validationStatus).toLowerCase() === 'validated', validationWarnings = [];
    if (!clean(input.mission).trim()) validationWarnings.push('Add a mission context before validation.');
    if (!actors.length || !activities.length || !clean(input.outcome).trim() || !exchanges.length || unresolved.length) validationWarnings.push('Complete and map the participants, activities, outcome and information exchanges before validation.');
    if (!allEvidence.length) validationWarnings.push('No selected evidence is linked to this concept.');
    if (!validationNotes) validationWarnings.push('Add analyst validation notes explaining the participants, exchange directions and evidence limitations.');
    if (!evidence.length && (nodes.filter(value => value.id !== 'outcome').some(value => !value.evidence.length) || exchanges.some(value => !value.evidence.length))) validationWarnings.push('Link evidence to every participant, activity and exchange, or provide an explicit concept-level evidence set.');
    if (actors.length > 4 || activities.length > 4 || exchanges.length > 8) validationWarnings.push('The visible diagram omits elements beyond four participants, four activities and eight exchanges. Review the full model in the snapshot or PowerPoint notes.');
    const validationStatus = declaredValidated && !validationWarnings.length ? 'validated' : 'draft';
    const validationLabel = validationStatus === 'validated' ? 'ANALYST-VALIDATED CONCEPT · Supplied relationships and evidence' : DRAFT;
    if (!declaredValidated) validationWarnings.unshift('Draft status. Operational relationships have not been marked validated by an analyst.');
    return { title: clean(input.title) || 'Operational concept overview', mission: clean(input.mission) || 'Mission context not supplied', actors, activities, outcome: clean(input.outcome), nodes, exchanges: exchanges.slice(0, 8), unresolved, original: input, evidence: allEvidence, validationStatus, validationLabel, validationNotes, validationWarnings, overflow: actors.length > 4 || activities.length > 4 || exchanges.length > 8 };
  }
  function svgText(value, x, y, options) {
    const o = options || {}, rows = wrap(value, o.width || 28, o.lines || 3);
    return `<text x="${x}" y="${y}" font-family="Arial,Helvetica,sans-serif" font-size="${o.size || 20}" fill="#${o.color || C.ink}"${o.bold ? ' font-weight="700"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${rows.map((row, i) => `<tspan x="${x}" dy="${i ? o.lineHeight || 23 : 0}">${esc(row)}</tspan>`).join('')}</text>`;
  }
  function endpoints(exchange) {
    const a = exchange.from, b = exchange.to, forward = b.x >= a.x;
    return { x1: forward ? a.x + a.w : a.x, y1: a.y + a.h / 2, x2: forward ? b.x : b.x + b.w, y2: b.y + b.h / 2 };
  }
  function ov1(input) {
    const m = model(input);
    const footer = m.validationWarnings[0] || 'Analyst validation notes: ' + m.validationNotes;
    const evidenceLabel = m.evidence.length ? 'Linked evidence: ' + m.evidence.map(item => '[' + item.n + '] ' + item.id).join('; ') : 'Linked evidence: none supplied';
    const metadata = { validationStatus: m.validationStatus, validationNotes: m.validationNotes, validationWarnings: m.validationWarnings, evidence: m.evidence.map(item => ({ ref: item.n, id: item.id, title: item.title, url: item.source, published: item.date, fetchedAt: item.fetchedAt, reviewed: item.reviewed })), fullModel: Object.assign({}, m.original, { records: undefined }) };
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-labelledby="ov1-title ov1-description"><title id="ov1-title">${esc(m.title)}</title><desc id="ov1-description">${esc(m.mission)}. ${esc(m.validationLabel)}. ${esc(m.validationWarnings.join(' '))}. ${esc(evidenceLabel)}. Nodes and exchanges reproduce the user-supplied concept.</desc><metadata>${esc(JSON.stringify(metadata))}</metadata><defs><marker id="ov1-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" fill="#${C.blue}"/></marker></defs><rect width="1200" height="675" fill="#${C.white}"/><rect width="1200" height="175" fill="#${C.navy}"/><rect y="175" width="1200" height="5" fill="#${C.gold}"/>${svgText(m.title, 48, 49, { width: 61, lines: 1, size: 31, color: C.white, bold: true })}${svgText(m.mission, 48, 94, { width: 103, lines: 2, size: 20, color: C.white })}${svgText(m.validationLabel, 48, 155, { width: 100, lines: 1, size: 16, color: C.gold, bold: true })}${svgText('ACTORS / CONTEXT', 48, 222, { size: 17, bold: true })}${svgText('OPERATIONAL ACTIVITIES', 475, 222, { size: 17, bold: true })}${svgText('MISSION OUTCOME', 902, 222, { size: 17, bold: true })}
      ${m.exchanges.map(exchange => { const p = endpoints(exchange); return `<path d="M${p.x1} ${p.y1}L${p.x2} ${p.y2}" fill="none" stroke="#${C.blue}" stroke-width="2" marker-end="url(#ov1-arrow)"/>`; }).join('')}
      ${m.nodes.map(node => `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="4" fill="#${C.pale}" stroke="#${C.blue}" stroke-width="2"/>${svgText(node.label + (node.evidence.length ? ' ' + citeText(node.evidence) : ''), node.x + 15, node.y + 24, { width: 25, lines: node.id === 'outcome' ? 4 : 2, size: 19, lineHeight: 23 })}`).join('')}
      ${m.exchanges.map(exchange => { const p = endpoints(exchange), x = (p.x1 + p.x2) / 2, y = (p.y1 + p.y2) / 2; return `<rect x="${x - 80}" y="${y - 28}" width="160" height="40" fill="#${C.white}" fill-opacity="0.94"/>${svgText(exchange.label + (exchange.evidence.length ? ' ' + citeText(exchange.evidence) : ''), x, y - 10, { width: 22, lines: 2, size: 14, lineHeight: 17, color: C.blue, anchor: 'middle' })}`; }).join('')}
      ${!m.actors.length ? svgText('Actors not supplied', 48, 277, { size: 19, color: C.muted }) : ''}${!m.activities.length ? svgText('Activities not supplied', 475, 277, { size: 19, color: C.muted }) : ''}${!m.outcome ? svgText('Outcome not supplied', 902, 370, { size: 19, color: C.muted }) : ''}<line x1="48" x2="1152" y1="584" y2="584" stroke="#CAD5DF"/>${svgText(footer, 48, 609, { width: 132, lines: 1, size: 15, lineHeight: 20, color: C.muted })}${svgText(evidenceLabel, 48, 635, { width: 136, lines: 1, size: 13, color: C.blue })}</svg>`;
  }
  async function downloadOv1(input) {
    const m = model(input);
    return Object.assign(download(filename(input && input.title || 'operational-concept') + '-ov1.svg', ov1(input), 'image/svg+xml;charset=utf-8'), { validationStatus: m.validationStatus, validationWarnings: m.validationWarnings });
  }

  function addText(slide, text, x, y, w, h, options) {
    slide.addText(clean(text), Object.assign({ x, y, w, h, fontFace: FONT, fontSize: 17, color: C.ink, margin: 0, breakLine: false, valign: 'top', paraSpaceAfterPt: 0 }, options || {}));
  }
  function page(slide, title, index, total) {
    slide.background = { color: C.white };
    slide.addShape('rect', { x: 0, y: 0, w: 13.333333, h: 0.09, line: { color: C.gold }, fill: { color: C.gold } });
    addText(slide, short(title, 65), 0.55, 0.35, 12.2, 0.7, { fontSize: 32, bold: true, color: C.navy });
    addText(slide, 'Source snapshot. Analyst assessments require review.', 0.55, 7.02, 11.2, 0.25, { fontSize: 11, color: C.muted });
    addText(slide, `${index} / ${total}`, 11.9, 7.02, 0.85, 0.25, { fontSize: 11, color: C.muted, align: 'right' });
  }
  function diagramSlide(pptx, input, index, total) {
    const slide = pptx.addSlide(), m = model(input), px = n => n / 90;
    slide.background = { color: C.white };
    slide.addShape('rect', { x: 0, y: 0, w: 13.333333, h: px(175), line: { color: C.navy }, fill: { color: C.navy } });
    slide.addShape('rect', { x: 0, y: px(175), w: 13.333333, h: px(5), line: { color: C.gold }, fill: { color: C.gold } });
    addText(slide, short(m.title, 64), px(48), px(24), px(1104), px(50), { fontSize: 31, bold: true, color: C.white });
    addText(slide, short(m.mission, 195), px(48), px(82), px(1104), px(51), { fontSize: 17, color: C.white });
    addText(slide, m.validationLabel, px(48), px(142), px(1104), px(28), { fontSize: 17, bold: true, color: C.gold });
    [['ACTORS / CONTEXT', 48], ['OPERATIONAL ACTIVITIES', 475], ['MISSION OUTCOME', 902]].forEach(([text, x]) => addText(slide, text, px(x), px(202), px(250), px(33), { fontSize: 17, bold: true }));
    m.exchanges.forEach(exchange => {
      const p = endpoints(exchange);
      slide.addShape('line', { x: px(Math.min(p.x1, p.x2)), y: px(Math.min(p.y1, p.y2)), w: px(Math.abs(p.x2 - p.x1)), h: px(Math.abs(p.y2 - p.y1)), flipH: p.x2 < p.x1, flipV: p.y2 < p.y1, line: { color: C.blue, width: 1.5, endArrowType: 'triangle' } });
    });
    m.nodes.forEach(node => {
      slide.addShape('rect', { x: px(node.x), y: px(node.y), w: px(node.w), h: px(node.h), fill: { color: C.pale }, line: { color: C.blue, width: 1.3 } });
      addText(slide, wrap(node.label + (node.evidence.length ? ' ' + citeText(node.evidence) : ''), 25, node.id === 'outcome' ? 4 : 2).join('\n'), px(node.x + 11), px(node.y + 8), px(node.w - 22), px(node.h - 12), { fontSize: 17, valign: 'mid' });
    });
    m.exchanges.forEach(exchange => {
      const p = endpoints(exchange), x = (p.x1 + p.x2) / 2, y = (p.y1 + p.y2) / 2;
      addText(slide, short(exchange.label + (exchange.evidence.length ? ' ' + citeText(exchange.evidence) : ''), 35), px(x - 82), px(y - 29), px(164), px(49), { fontSize: 17, align: 'center', valign: 'mid', fill: { color: C.white }, margin: 0.02 });
    });
    if (!m.actors.length) addText(slide, 'Actors not supplied', px(48), px(260), px(250), px(40), { color: C.muted });
    if (!m.activities.length) addText(slide, 'Activities not supplied', px(475), px(260), px(250), px(40), { color: C.muted });
    if (!m.outcome) addText(slide, 'Outcome not supplied', px(902), px(350), px(250), px(40), { color: C.muted });
    const note = m.validationWarnings[0] || 'Analyst validation notes: ' + m.validationNotes;
    addText(slide, short(note, 145), px(48), px(590), px(1104), px(35), { fontSize: 15, color: C.muted });
    addText(slide, short('Linked evidence: ' + (m.evidence.length ? citeText(m.evidence) + '. Full source details and validation notes in speaker notes.' : 'None supplied.'), 150), px(48), px(631), px(1104), px(25), { fontSize: 13, color: C.blue });
    addText(slide, `${index} / ${total}`, 11.9, 7.15, 0.85, 0.2, { fontSize: 11, color: C.muted, align: 'right' });
    slide.addNotes(`${m.validationLabel}\nAnalyst validation notes: ${m.validationNotes || 'Not supplied'}\nValidation warnings: ${m.validationWarnings.join(' ') || 'None'}\nThis concept reproduces user-supplied actors, activities, outcomes and exchanges. It does not infer an actual DoDAF architecture from competitor evidence. Analyst validation is not an independent source verification.\n\nLinked source records:\n${m.evidence.map(sourceNotes).join('\n\n')}\n\nFull supplied model:\n${JSON.stringify(Object.assign({}, m.original, { records: undefined }), null, 2)}`);
  }
  async function presentation(options) {
    const c = context(options), data = c.data, title = clean(data.title) || 'Competitive intelligence brief';
    const items = c.items, names = companyNames(data.companies);
    if (!items.length && !data.ov1) throw new Error('Select evidence records or supply an operational concept.');
    const PptxGen = root.pptxgen || root.PptxGenJS;
    if (typeof PptxGen !== 'function') throw new Error('The PowerPoint export library is not loaded. Refresh the app and try again.');
    const pptx = new PptxGen();
    pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'Competitive Intelligence Workspace'; pptx.subject = 'Selected evidence and supplied analyst assessments';
    pptx.title = title; pptx.company = ''; pptx.lang = 'en-US';
    pptx.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'en-US' };
    const displayed = items.slice(0, 24), evidenceCount = Math.ceil(displayed.length / 2), appendixCount = Math.ceil(items.length / 4);
    const total = 1 + c.findings.length + evidenceCount + appendixCount + (data.ov1 ? 1 : 0);
    let number = 1;
    const cover = pptx.addSlide(); cover.background = { color: C.navy };
    cover.addShape('rect', { x: 0.6, y: 1.55, w: 0.1, h: 3.9, line: { color: C.gold }, fill: { color: C.gold } });
    addText(cover, short(title, 120), 1.0, 1.65, 11.3, 2.3, { fontSize: 42, bold: true, color: C.white });
    addText(cover, `${c.template} · ${items.length} evidence record${items.length === 1 ? '' : 's'}\nGenerated ${c.generatedAt.slice(0, 10)} · Snapshot ${c.snapshotId}`, 1.0, 4.2, 11.3, 0.8, { fontSize: 20, color: C.white });
    addText(cover, short(names.length ? 'Scope: ' + names.join(', ') : 'Evidence and analyst assessment', 220), 1.0, 5.3, 11.3, 0.8, { fontSize: 17, color: C.white });
    addText(cover, items.length > 24 ? 'Evidence slides show the first 24 records. The source appendix includes the full selection, with complete text in notes.' : 'Sources and full record text appear in the speaker notes. Validate evidence before using it in a decision.', 1.0, 6.4, 11.3, 0.6, { fontSize: 17, color: 'D4DFE8' });
    cover.addNotes(`Generated ${c.generatedAt}.\nSnapshot ${c.snapshotId}.\nTemplate: ${c.template}.\nSelected companies: ${names.join(', ') || 'Not specified'}.\nSelected records: ${items.length}.\nEvidence slides display at most 24 selected records. The source appendix and its notes preserve every selected record.\nSource record text may be a feed excerpt. Implications and recommended actions are analyst inference. Confidence is analyst supplied. This export does not independently verify source claims. Download the matching evidence snapshot JSON to retain complete structured records and model inputs.`);
    c.findings.forEach(finding => {
      const slide = pptx.addSlide(); page(slide, 'Decision finding ' + finding.n, ++number, total);
      addText(slide, 'REPORTED CHANGE', 0.55, 1.27, 12.2, 0.3, { fontSize: 14, bold: true, color: C.muted });
      addText(slide, short(finding.change || 'No change supplied.', 260), 0.55, 1.65, 12.2, 1.0, { fontSize: 23, bold: true, color: C.navy });
      addText(slide, 'WHY IT MATTERS · ANALYST INFERENCE', 0.55, 2.83, 12.2, 0.3, { fontSize: 14, bold: true, color: C.muted });
      addText(slide, short(finding.implication || 'No implication supplied.', 330), 0.55, 3.21, 12.2, 1.0, { fontSize: 20 });
      addText(slide, 'RECOMMENDED ACTION', 0.55, 4.39, 12.2, 0.3, { fontSize: 14, bold: true, color: C.blue });
      addText(slide, short(finding.action || 'No action supplied.', 270), 0.55, 4.77, 12.2, 0.85, { fontSize: 20, color: C.blue });
      addText(slide, short(`Analyst-supplied confidence: ${finding.confidence} · Owner: ${finding.owner || 'Not assigned'} · Due: ${finding.due || 'Not assigned'}`, 165), 0.55, 5.9, 12.2, 0.42, { fontSize: 15, color: C.muted });
      addText(slide, short('Evidence references: ' + citeText(finding.evidence) + '. Source links and complete finding text in notes and source register.', 175), 0.55, 6.45, 12.2, 0.35, { fontSize: 14, color: C.blue });
      slide.addNotes(findingNotes(finding));
    });
    for (let start = 0; start < displayed.length; start += 2) {
      const slide = pptx.addSlide(); page(slide, 'Selected evidence ' + (Math.floor(start / 2) + 1), ++number, total);
      const group = displayed.slice(start, start + 2);
      group.forEach((item, offset) => {
        const y = offset ? 4.03 : 1.27;
        addText(slide, short(`[${item.n}] ${item.company} · ${item.category} · Published ${item.date || 'not supplied'}`, 105), 0.55, y, 12.2, 0.3, { fontSize: 17, color: C.muted });
        addText(slide, short(item.title, 103), 0.55, y + 0.38, 12.2, 0.52, { fontSize: 20, bold: true, color: C.navy });
        addText(slide, 'Evidence: ' + short(item.summary, 190), 0.55, y + 0.95, 12.2, 0.67, { fontSize: 17 });
        addText(slide, 'Assessment: ' + short(item.assessment || 'No assessment supplied.', 148), 0.55, y + 1.64, 12.2, 0.52, { fontSize: 17, color: C.blue });
        addText(slide, item.source ? `[${item.n}] Read source. Full text and dates in notes.` : `[${item.n}] No valid source URL supplied.`, 0.55, y + 2.2, 12.2, 0.29, Object.assign({ fontSize: 17, color: C.blue }, item.source ? { hyperlink: { url: item.source } } : {}));
      });
      slide.addNotes(group.map(sourceNotes).join('\n\n====================\n\n'));
    }
    if (data.ov1) diagramSlide(pptx, Object.assign({}, data.ov1, { records: data.records }), ++number, total);
    for (let start = 0; start < items.length; start += 4) {
      const slide = pptx.addSlide(); page(slide, 'Source register ' + (Math.floor(start / 4) + 1), ++number, total);
      const group = items.slice(start, start + 4);
      group.forEach((item, offset) => {
        const y = 1.3 + offset * 1.35;
        addText(slide, `[${item.n}] ` + short(item.title, 104), 0.55, y, 12.2, 0.55, { fontSize: 18, bold: true, color: C.navy });
        addText(slide, item.source ? short(item.source, 112) : 'No valid source URL supplied.', 0.55, y + 0.57, 12.2, 0.33, Object.assign({ fontSize: 17, color: C.blue }, item.source ? { hyperlink: { url: item.source } } : {}));
        addText(slide, short(`${item.company} · Published ${item.date || 'not supplied'} · Retrieved ${item.fetchedAt || 'not supplied'} · Reviewed ${item.reviewed || 'not supplied'}`, 135), 0.55, y + 0.93, 12.2, 0.3, { fontSize: 14, color: C.muted });
      });
      slide.addNotes(group.map(sourceNotes).join('\n\n====================\n\n'));
    }
    const blob = await pptx.write({ outputType: 'blob', compression: true });
    return Object.assign(download(filename(title) + '.pptx', blob, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), { slides: total, records: items.length, evidenceSlides: evidenceCount, findings: c.findings.length, snapshotId: c.snapshotId });
  }
  root.IntelExports = Object.freeze({ report, presentation, snapshot, ov1, downloadOv1 });
})(typeof window !== 'undefined' ? window : globalThis);
