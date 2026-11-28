#!/usr/bin/env node
// Diagnostic: send one window to /api/alpha/extractions and print the RAW answer objects, so the
// presence or absence of `span`, `type`, `p_null` is observed rather than assumed.
//   node extract-test/verify-tmp/alpha-probe.mjs --doc <file> --start 10000 --size 3000 --fields "premises_address:Find the postal address of the demised premises, as written"
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DOC = arg('doc', 'extract-test/docs/legal-property/01-property-lease.txt');
const START = Number(arg('start', '0'));
const SIZE = Number(arg('size', '3000'));
const RAW_FIELDS = arg('fields', 'invoice_number:Find the invoice number or reference.|effective_date:Find the execution or effective date in the text.');

const fields = {};
for (const spec of RAW_FIELDS.split('|')) {
  const at = spec.indexOf(':');
  fields[spec.slice(0, at)] = { type: 'text', instructions: spec.slice(at + 1) };
}

const points = Array.from(readFileSync(DOC, 'utf8'));
const chunk = points.slice(START, START + SIZE).join('');

const res = await fetch('https://openrouter.ai/api/alpha/extractions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'scaledown/extract', state: chunk, fields }),
  signal: AbortSignal.timeout(90_000),
});
const body = await res.json().catch(async () => ({ non_json: await res.text() }));
console.log(JSON.stringify({ status: res.status, window: [START, START + SIZE], fields: Object.keys(fields), body }, null, 1));
