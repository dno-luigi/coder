#!/usr/bin/env node
// Paired A/B: archived wording (which failed) vs the sheet's instruction-style wording.
// Task card: extract-test/verify-tmp/TASK-CARD-ab-wording.json
//
//   node extract-test/verify-tmp/ab-wording.mjs
//
// Each document is sent twice on the same endpoint with the same settings; only the description
// text differs. Both arms use the chat-completions shape the original runs used, so the comparison
// isolates wording.
//
// Limits: 24 calls, 0.05 USD. Writes only extract-test/out/ab-wording/.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY;
const OUT = 'extract-test/out/ab-wording';
const BUDGET = 0.05;
mkdirSync(OUT, { recursive: true });
if (!KEY) { console.error('no OPENROUTER_API_KEY'); process.exit(2); }

const LEASE = (n) => `extract-test/docs/legal-property/${String(n).padStart(2, '0')}-property-lease.txt`;
const CASE = 'extract-test/docs/cases/faretta-422us806.txt';
const DENIAL = (l) => `extract-test/docs/medical-denials/denial-${l}.txt`;

// Wording recovered from extract-test/out/*/locate.json (the text actually sent) vs the sheet.
const PAIRS = {
  security_deposit: {
    old: 'Find the security deposit or letter of credit amount required under the lease, expressed as written.',
    new: 'Find the amount held as a security deposit or letter of credit, exactly as printed with currency. If the lease requires no deposit, return nothing — do not return the words null, none, N/A, or the phrase null and void.',
  },
  case_name: {
    old: 'Find the name of the case as reported, exactly as written, including the parties.',
    new: "Quote the case name exactly as this document prints it, including the parties' full names and the words Petitioner and Respondent. Do not substitute the well-known short name of the case.",
  },
  disposition: {
    old: 'Find the disposition of the judgment under review — what the court did with the decision below, as written, for example "reversed and remanded".',
    new: 'Quote the sentence that states what the court did with the judgment below, for example "Vacated and remanded." Return the sentence as printed, including its capitalisation and full stop.',
  },
  appeal_deadline: {
    old: 'Find the last date on which an appeal may be filed, as written; compute it only if the letter states a filing window in days from the letter date.',
    new: 'Find the date by which an appeal must be filed, as printed in the letter. Return only a date that appears in the document; do not calculate one from a number of days.',
  },
};

const JOBS = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `lease-0${n}`, doc: LEASE(n), fields: ['security_deposit'] })),
  { id: 'case-faretta', doc: CASE, fields: ['case_name', 'disposition'] },
  ...['a', 'b', 'c'].map((l) => ({ id: `denial-${l}`, doc: DENIAL(l), fields: ['appeal_deadline'] })),
];

let spent = 0;
let calls = 0;

async function arm(docText, field, description, armName) {
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
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = JSON.parse(raw); } catch { /* keep null */ }
  const cost = json?.usage?.cost ?? 0;
  spent += cost;
  let ents = [];
  if (res.ok) {
    try { ents = JSON.parse(json.choices[0].message.content).entities ?? []; } catch { /* empty */ }
  }
  return {
    arm: armName, status: res.status, ms, cost,
    values: ents.filter((e) => e.type === field).map((e) => ({
      text: String(e.text),
      conf: e.confidence,
      start: e.start, end: e.end,
      span: docText.slice(e.start, e.end),
      spanOk: docText.slice(e.start, e.end) === e.text,
    })),
    omitted: ents.filter((e) => e.type === field).length === 0,
    error: res.ok ? undefined : raw.slice(0, 200),
  };
}

const rows = [];
for (const job of JOBS) {
  const docText = readFileSync(job.doc, 'utf8');
  for (const field of job.fields) {
    if (calls + 2 > 24 || spent + 0.01 > BUDGET) { console.log('[stop] limit reached'); break; }
    const oldR = await arm(docText, field, PAIRS[field].old, 'old');
    const newR = await arm(docText, field, PAIRS[field].new, 'new');
    rows.push({ id: job.id, field, old: oldR, new: newR });
    const fmt = (r) => r.error ? `ERR ${r.error}`
      : r.omitted ? 'OMITTED'
      : r.values.map((v) => `${JSON.stringify(v.text)} @${String(v.conf).slice(0, 5)} ${v.spanOk ? 'span-ok' : 'SPAN-FAIL→' + JSON.stringify(v.span.slice(0, 28))}`).join(' | ');
    console.log(`\n${job.id}  [${field}]`);
    console.log(`  old $${oldR.cost.toFixed(6)} ${oldR.ms}ms  ${fmt(oldR)}`);
    console.log(`  new $${newR.cost.toFixed(6)} ${newR.ms}ms  ${fmt(newR)}`);
    writeFileSync(join(OUT, `${job.id}__${field}.json`), JSON.stringify({ old: oldR, new: newR }, null, 2));
  }
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ rows, spent, calls }, null, 2));
console.log(`\ntotal $${spent.toFixed(6)} across ${calls} calls (ceiling 0.05 / 24 calls)`);
