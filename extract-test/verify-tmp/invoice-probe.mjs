#!/usr/bin/env node
// Reproduction test for the published "Extract invoice fields with ScaleDown Extract" recipe.
// Task card: extract-test/verify-tmp/TASK-CARD-invoice-probe.json
//
//   node extract-test/verify-tmp/invoice-probe.mjs
//
// Claims under test:
//   1. the documented Responses API call shape works with provider.options.scaledown.entities
//   2. the captured output's start/end offsets index into the invoice correctly (free, no call)
//   3. running the same invoice twice returns the same fields
//   4. a field that is not in the invoice is omitted (VAT line removed)
//
// Limits: 3 model calls, 0.02 USD. Writes only extract-test/out/invoice/.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY;
const OUT = 'extract-test/out/invoice';
mkdirSync(OUT, { recursive: true });
if (!KEY) { console.error('no OPENROUTER_API_KEY'); process.exit(2); }

const INVOICE_ENTITIES = {
  vendor: 'Name of the company issuing the invoice',
  invoice_number: 'Invoice number or reference',
  subtotal: 'Subtotal before tax, with currency',
  vat: 'VAT or sales tax amount, with currency',
  total: 'Total amount due including tax, with currency',
  due_date: 'Payment due date',
};

const INVOICE = `INVOICE
Northwind Traders GmbH
Invoice No: NW-2026-0417
Date: 2026-09-30
Due: 2026-10-30

Consulting (10h)         EUR 1,500.00
Cloud hosting (Sept)     EUR 320.00

Subtotal                 EUR 1,820.00
VAT 19%                  EUR 345.80
Total due                EUR 2,165.80`;

// Claim 2, no model call: do the page's own offsets index into the invoice?
const CAPTURED = [
  { type: 'vendor', text: 'Northwind Traders GmbH', confidence: 1, start: 8, end: 30 },
  { type: 'invoice_number', text: 'NW-2026-0417', confidence: 1, start: 43, end: 55 },
  { type: 'subtotal', text: 'EUR 1,820.00', confidence: 0.999, start: 190, end: 202 },
  { type: 'vat', text: 'EUR 345.80', confidence: 1, start: 228, end: 238 },
  { type: 'total', text: 'EUR 2,165.80', confidence: 1, start: 264, end: 276 },
  { type: 'due_date', text: '2026-10-30', confidence: 1, start: 78, end: 88 },
];
console.log('=== documented offsets: INVOICE.slice(start,end) ===');
let offsetOk = 0;
for (const e of CAPTURED) {
  const got = INVOICE.slice(e.start, e.end);
  const ok = got === e.text;
  if (ok) offsetOk++;
  console.log(`  ${e.type.padEnd(15)} ${ok ? 'OK  ' : 'FAIL'} ${JSON.stringify(got)} vs ${JSON.stringify(e.text)}`);
}
console.log(`  ${offsetOk}/${CAPTURED.length} offsets correct`);

async function extract(text) {
  const t0 = performance.now();
  const res = await fetch('https://openrouter.ai/api/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'scaledown/extract', input: text, provider: { options: { scaledown: { entities: INVOICE_ENTITIES } } } }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) return { status: res.status, ms, error: raw.slice(0, 300) };
  const body = JSON.parse(raw);
  const message = [...body.output].reverse().find((i) => i.type === 'message');
  const outputText = message?.content?.find((p) => p.type === 'output_text')?.text;
  if (outputText === undefined) return { status: res.status, ms, error: 'no output_text', keys: Object.keys(body) };
  const entities = JSON.parse(outputText).entities ?? [];
  return { status: res.status, ms, cost: body.usage?.cost, input_tokens: body.usage?.input_tokens, entities, raw: body };
}

function show(tag, r, source) {
  if (r.error) { console.log(`${tag}: HTTP ${r.status} ${r.ms}ms ERROR ${r.error}`); return; }
  console.log(`${tag}: HTTP ${r.status} ${r.ms}ms $${(r.cost ?? 0).toFixed(6)} ${r.input_tokens} tok, ${r.entities.length} entities`);
  for (const e of r.entities) {
    const span = source.slice(e.start, e.end);
    const hit = span === e.text ? 'span-ok' : `span-MISMATCH ${JSON.stringify(span.slice(0, 30))}`;
    console.log(`    ${e.type.padEnd(15)} ${JSON.stringify(e.text).padEnd(24)} conf ${String(e.confidence).slice(0, 5)} [${e.start}:${e.end}] ${hit}`);
  }
}

console.log('\n=== run 1 (the documented invoice) ===');
const r1 = await extract(INVOICE);
show('run1', r1, INVOICE);
writeFileSync(join(OUT, 'run1.json'), JSON.stringify(r1.raw ?? r1, null, 2));

console.log('\n=== run 2 (determinism) ===');
const r2 = await extract(INVOICE);
show('run2', r2, INVOICE);
writeFileSync(join(OUT, 'run2.json'), JSON.stringify(r2.raw ?? r2, null, 2));

if (r1.entities && r2.entities) {
  const key = (r) => Object.fromEntries(r.entities.map((e) => [e.type, e.text]));
  const a = key(r1), b = key(r2);
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`\n  determinism: ${same ? 'IDENTICAL fields' : 'DIFFERENT fields'}`);
  if (!same) for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) console.log(`    ${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
  const doc = Object.fromEntries(CAPTURED.map((e) => [e.type, e.text]));
  const diffs = Object.entries(doc).filter(([k, v]) => a[k] !== v);
  console.log(`  vs documented output: ${diffs.length === 0 ? 'all 6 match' : diffs.map(([k, v]) => `${k} got ${JSON.stringify(a[k])} want ${JSON.stringify(v)}`).join('; ')}`);
}

console.log('\n=== run 3 (VAT line removed: is the field omitted?) ===');
const NO_VAT = INVOICE.split('\n').filter((l) => !l.startsWith('VAT')).join('\n');
console.log('  last 3 lines now: ' + JSON.stringify(NO_VAT.split('\n').slice(-3)));
const r3 = await extract(NO_VAT);
show('run3', r3, NO_VAT);
writeFileSync(join(OUT, 'run3.json'), JSON.stringify(r3.raw ?? r3, null, 2));
if (r3.entities) {
  const v = r3.entities.find((e) => e.type === 'vat');
  console.log(`  vat present? ${v ? `YES -> ${JSON.stringify(v.text)}, span ${JSON.stringify(NO_VAT.slice(v.start, v.end))} (the invoice has no VAT line)` : 'no, omitted'}`);
  const t = r3.entities.find((e) => e.type === 'total');
  const s = r3.entities.find((e) => e.type === 'subtotal');
  console.log(`  subtotal ${JSON.stringify(s?.text)} total ${JSON.stringify(t?.text)}`);
}
const totalCost = [r1, r2, r3].reduce((a, r) => a + (r.cost ?? 0), 0);
console.log(`\n  total cost $${totalCost.toFixed(6)} across 3 calls (limit 0.02 / 6 calls)`);
