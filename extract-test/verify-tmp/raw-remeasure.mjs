#!/usr/bin/env node
// Harness-free re-measurement of the legal vertical and the case.
// Task card: extract-test/verify-tmp/TASK-CARD-raw-remeasure.json
//
//   node extract-test/verify-tmp/raw-remeasure.mjs
//
// One call per (document, field). The archived descriptions are sent byte-identical to what the
// harness sent; the only change is that each call carries a single entity instead of six. Scoring is
// three mechanical checks and nothing else: found, span-equal, normalised containment.
// The archived harness run is then scored with the same three checks for a like-for-like table.
//
// Limits: 48 calls, 0.05 USD.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY;
const OUT = 'extract-test/out/raw-remeasure';
const BUDGET = 0.05;
const MAX_CALLS = 48;
mkdirSync(OUT, { recursive: true });
if (!KEY) { console.error('no OPENROUTER_API_KEY'); process.exit(2); }

// Descriptions copied from extract-test/out/legal/locate.json and extract-test/out/case/locate.json.
const LEGAL_FIELDS = {
  landlord_name: 'Find the full legal name of the entity granting the lease, including any company or government suffix, exactly as written.',
  tenant_name: 'Find the full legal name of the entity taking the lease, including any company suffix, exactly as written.',
  premises_address: 'Find the postal address or legal description of the demised premises, exactly as written.',
  commencement_date: 'Find the date on which the lease term commences, as written in the document.',
  base_rent: 'Find the annual or monthly base rent figure stated in the rent clause, expressed as written, for example "one hundred thousand dollars ($100,000) per year"; do not normalise it.',
  security_deposit: 'Find the security deposit or letter of credit amount required under the lease, expressed as written.',
};
const CASE_FIELDS = {
  case_name: 'Find the name of the case as reported, exactly as written, including the parties.',
  citation: 'Find the United States Reports citation for this case, exactly as written, for example "422 U.S. 806".',
  court: 'Find the name of the court that decided this case, exactly as written.',
  decision_date: 'Find the date on which the court decided the case, as written in the headnote or at the end of the opinion.',
  authoring_justice: 'Find the name of the justice who delivered the opinion of the Court, exactly as written.',
  disposition: 'Find the disposition of the judgment under review — what the court did with the decision below, as written, for example "reversed and remanded".',
};

const LEASE = (n) => `extract-test/docs/legal-property/${String(n).padStart(2, '0')}-property-lease.txt`;
const JOBS = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ vertical: 'legal', id: `lease-0${n}`, doc: LEASE(n), fields: LEGAL_FIELDS })),
  { vertical: 'case', id: 'case-faretta', doc: 'extract-test/docs/cases/faretta-422us806.txt', fields: CASE_FIELDS },
];

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

let spent = 0, calls = 0;
const raw = [];

for (const job of JOBS) {
  const docText = readFileSync(job.doc, 'utf8');
  const docNorm = norm(docText);
  const perField = {};
  for (const [field, description] of Object.entries(job.fields)) {
    if (calls + 1 > MAX_CALLS || spent >= BUDGET) { console.log('[stop] limit'); break; }
    calls++;
    const t0 = performance.now();
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
      body: JSON.stringify({
        model: 'scaledown/extract',
        messages: [{ role: 'user', content: docText }],
        provider: { options: { scaledown: { entities: { [field]: { description } }, threshold: 0, context_chars: 500 } } },
      }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    const cost = json?.usage?.cost ?? 0; spent += cost;
    let ents = [];
    if (res.ok) { try { ents = JSON.parse(json.choices[0].message.content).entities ?? []; } catch { /* */ } }
    const vals = ents.filter((e) => e.type === field).map((e) => {
      const span = docText.slice(e.start, e.end);
      return { text: String(e.text), conf: e.confidence, start: e.start, end: e.end, spanOk: span === e.text, normContained: docNorm.includes(norm(e.text)) };
    });
    perField[field] = { status: res.status, ms, cost, values: vals, omitted: vals.length === 0, error: res.ok ? undefined : text.slice(0, 200) };
    const show = perField[field].error ? `ERR ${perField[field].error.slice(0, 60)}`
      : vals.length === 0 ? 'OMITTED'
      : vals.map((v) => `${JSON.stringify(v.text.slice(0, 46))} @${String(v.conf).slice(0, 5)} ${v.spanOk ? 'span-ok' : 'span-fail'}${v.normContained ? '' : ' NOT-IN-DOC'}`).join(' | ');
    console.log(`${job.id} ${field.padEnd(18)} ${String(res.status)} ${String(ms).padStart(5)}ms $${cost.toFixed(6)}  ${show}`);
  }
  writeFileSync(join(OUT, `${job.id}.json`), JSON.stringify(perField, null, 2));
  raw.push({ id: job.id, vertical: job.vertical, perField });
}

// ---- like-for-like scoring ----
const score = (entries) => {
  // entries: [{field, values:[{spanOk,normContained,conf,text}], omitted}]
  let found = 0, exact = 0, contained = 0, ungrounded = 0;
  const bad = [];
  for (const e of entries) {
    if (e.omitted) continue;
    found++;
    const v = e.values[0];
    if (v.spanOk) exact++;
    if (v.normContained) contained++; else { ungrounded++; bad.push({ field: e.field, text: v.text, conf: v.conf }); }
  }
  return { found, exact, contained, ungrounded, bad };
};

console.log('\n=== harness (6 fields per call) vs raw (1 field per call) ===');
const table = [];
for (const job of JOBS) {
  const archivedPath = job.vertical === 'legal' ? 'extract-test/out/legal/results.json' : 'extract-test/out/case/results.json';
  const archived = JSON.parse(readFileSync(archivedPath, 'utf8'));
  const docEntry = archived.results.find((d) => d.file === job.doc.split('/').pop());
  const docText = readFileSync(job.doc, 'utf8');
  const docNorm = norm(docText);

  const harnessEntries = Object.keys(job.fields).map((field) => {
    const vals = (docEntry?.fields?.[field] ?? []).map((v) => {
      const end = v.end ?? (v.start + String(v.text).length);
      const span = docText.slice(v.start, end);
      return { text: String(v.text), conf: v.confidence, spanOk: span === v.text, normContained: docNorm.includes(norm(v.text)) };
    });
    return { field, values: vals, omitted: vals.length === 0 };
  });
  const rawEntries = Object.keys(job.fields).map((field) => ({ field, ...(raw.find((r) => r.id === job.id).perField[field]) }));

  const h = score(harnessEntries), r = score(rawEntries);
  table.push({ id: job.id, harness: h, raw: r });
  console.log(`${job.id.padEnd(14)} harness ${h.found}/${Object.keys(job.fields).length} found, ${h.exact} span-equal, ${h.contained} in-doc, ${h.ungrounded} ungrounded`);
  console.log(`${''.padEnd(14)} raw     ${r.found}/${Object.keys(job.fields).length} found, ${r.exact} span-equal, ${r.contained} in-doc, ${r.ungrounded} ungrounded`);
  for (const b of [...h.bad, ...r.bad]) console.log(`     ungrounded [${b.field}] ${JSON.stringify(String(b.text).slice(0, 50))} @${b.conf}`);
}

const total = (k) => table.reduce((a, t) => ({ found: a.found + t.harness.found, exact: a.exact + t.harness.exact, contained: a.contained + t.harness.contained, ungrounded: a.ungrounded + t.harness.ungrounded }), { found: 0, exact: 0, contained: 0, ungrounded: 0 });
const totalRaw = (k) => table.reduce((a, t) => ({ found: a.found + t.raw.found, exact: a.exact + t.raw.exact, contained: a.contained + t.raw.contained, ungrounded: a.ungrounded + t.raw.ungrounded }), { found: 0, exact: 0, contained: 0, ungrounded: 0 });
console.log('\nTOTAL harness', JSON.stringify(total()), '\nTOTAL raw    ', JSON.stringify(totalRaw()));
console.log(`\nspent $${spent.toFixed(6)} across ${calls} calls (ceiling 0.05 / 48 calls)`);
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ table, spent, calls }, null, 2));
