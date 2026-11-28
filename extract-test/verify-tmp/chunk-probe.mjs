#!/usr/bin/env node
// Does chunking help? The brief's correspondent says the docs specify no ideal document size or
// chunking strategy, so this measures it rather than assuming.
//
//   node extract-test/verify-tmp/chunk-probe.mjs
//
// Same six fields, same descriptions, same document as the whole-document run in
// extract-test/out/case/. The only change is that the document is split at line boundaries into five
// chunks and each chunk is extracted separately. Reports per-field union recall, verbatim rate, and
// whether the canonical-name substitution survives chunking.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY || process.env.SCALEDOWN_API_KEY;
const OUT = 'extract-test/out/chunk';
const DOC = 'extract-test/docs/cases/faretta-422us806.txt';
const BUDGET = 0.02;
mkdirSync(OUT, { recursive: true });
if (!KEY) { console.error('no key'); process.exit(2); }

const FIELDS = {
  case_name: 'Find the name of the case as reported, exactly as written, including the parties.',
  citation: 'Find the United States Reports citation for this case, exactly as written, for example "422 U.S. 806".',
  court: 'Find the name of the court that decided this case, exactly as written.',
  decision_date: 'Find the date on which the court decided the case, as written in the headnote or at the end of the opinion.',
  authoring_justice: 'Find the name of the justice who delivered the opinion of the Court, exactly as written.',
  disposition: 'Find the disposition of the judgment under review — what the court did with the decision below, as written, for example "reversed and remanded".',
};

const doc = readFileSync(DOC, 'utf8');
const N = 5;
const size = Math.ceil(doc.length / N);
const chunks = [];
for (let i = 0; i < N; i++) {
  const start = i * size;
  let end = Math.min(doc.length, (i + 1) * size);
  if (end < doc.length) { const nl = doc.indexOf('\n', end); if (nl > 0) end = nl; }
  chunks.push({ start, end, text: doc.slice(start, end) });
}

let spent = 0;
const results = [];

for (const [i, c] of chunks.entries()) {
  const t0 = performance.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
    body: JSON.stringify({
      model: 'scaledown/extract',
      messages: [{ role: 'user', content: c.text }],
      provider: { options: { scaledown: { entities: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, { description: v }])), threshold: 0, context_chars: 200 } } },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = JSON.parse(raw); } catch { /* keep null */ }
  const cost = json?.usage?.cost ?? 0;
  spent += cost;
  let ents = [];
  try { ents = JSON.parse(json.choices[0].message.content).entities ?? []; } catch { /* keep empty */ }
  const row = {
    chunk: i + 1, start: c.start, end: c.end, chars: c.text.length, status: res.status, ms, cost,
    found: [...new Set(ents.map((e) => e.type))],
    values: ents.map((e) => ({ field: e.type, text: String(e.text), conf: e.confidence, verbatim: c.text.slice(e.start, e.end) === e.text })),
  };
  results.push(row);
  writeFileSync(join(OUT, `chunk-${i + 1}.json`), JSON.stringify({ request: c.text.length, response: json ?? raw }, null, 2));
  console.log(`chunk ${i + 1} [${c.start}-${c.end}] ${c.text.length} chars  ${row.status} ${ms} ms $${cost.toFixed(6)}  found ${row.found.join(',') || '(none)'}`);
  if (spent >= BUDGET) { console.log('[stop] budget'); break; }
}

// Union recall vs the six fields, and whether the canonical-name substitution survived.
const union = {};
for (const r of results) for (const v of r.values) (union[v.field] ??= []).push({ ...v, chunk: r.chunk });
const whole = JSON.parse(readFileSync('extract-test/out/case/results.json', 'utf8')).results[0].fields;
console.log('\n=== union from 5 chunks vs whole-document ===');
for (const f of Object.keys(FIELDS)) {
  const u = union[f] ?? [];
  const w = (whole[f] ?? [])[0];
  console.log(`${f.padEnd(20)} chunks: ${u.length} value(s) ${JSON.stringify(u.map((v) => v.text).slice(0, 2))}  |  whole: ${w ? JSON.stringify(String(w.text).slice(0, 44)) : '(none)'}`);
}
console.log(`\nspent $${spent.toFixed(6)} across ${results.length} chunk calls`);
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ chunks: results.map(({ values, ...r }) => r), union, spent }, null, 2));
