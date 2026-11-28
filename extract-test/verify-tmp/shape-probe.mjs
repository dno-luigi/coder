#!/usr/bin/env node
// Probe the two request shapes the brief documents, before building anything on them.
//
//   OPENROUTER_API_KEY=... node extract-test/verify-tmp/shape-probe.mjs
//
// Checks, in order:
//   1. Locate via `provider.options.scaledown.entities` — does it accept field descriptions,
//      and does `threshold` actually filter? (My earlier probes found `extra_body` dropped.)
//   2. Locate via `response_format.json_schema` — the shape I have been using.
//   3. Decide via `/api/alpha/decisions` with `classify-1` — does it exist, and what comes back?
//
// Raw responses are written to extract-test/out-shape/ so every claim below is re-derivable.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY || process.env.SCALEDOWN_API_KEY;
const ROOT = 'https://openrouter.ai/api';
const OUT = 'extract-test/out-shape';
const BUDGET = 0.01;
let spent = 0;

mkdirSync(OUT, { recursive: true });
if (!KEY) { console.error('no key'); process.exit(2); }

const doc = `COMMERCIAL LEASE — KEY TERMS
Landlord: Bracken Property Holdings plc, of 3 Wellington Place, Leeds LS1 4AP.
Tenant: Halcyon Retail Limited, of 18 Kirkstall Road, Leeds LS3 1LY.
Premises: Unit 14, Kingsway Retail Park, Gelderd Road, Leeds LS12 6BQ.
Term: ten (10) years commencing on 1 April 2024.
Rent: £84,500 per year, payable quarterly in advance.
Service charge: estimated at £6,200 for the first year.
Insurance premium: not stated in this document.`;

async function call(name, path, body, auth = 'bearer') {
  if (spent >= BUDGET) return { skipped: true };
  const t0 = performance.now();
  const headers = { 'content-type': 'application/json' };
  if (auth === 'bearer') headers.authorization = `Bearer ${KEY}`;
  headers['x-api-key'] = KEY;
  const res = await fetch(`${ROOT}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = JSON.parse(raw); } catch { /* keep null */ }
  const cost = json?.usage?.cost ?? 0;
  spent += cost;
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ name, path, status: res.status, ms, cost, body, raw: json ?? raw }, null, 2));
  console.log(`${name.padEnd(22)} HTTP ${res.status} ${String(ms).padStart(6)} ms $${cost.toFixed(6)}`);
  return { status: res.status, json, ms, cost };
}

// ---------------------------------------------------------------- 1. provider.options shape
const entities = {
  tenant_name: { description: 'Find the full legal name of the tenant, including any company suffix.' },
  annual_rent: { description: 'Find the yearly rent figure, including the currency symbol.' },
  insurance_premium: { description: 'Find the annual insurance premium, including the currency symbol.' },
};

const a = await call('locate-provider-options', '/v1/chat/completions', {
  model: 'scaledown/extract',
  messages: [{ role: 'user', content: doc }],
  provider: { options: { scaledown: { entities, threshold: 0, context_chars: 500 } } },
});

const b = await call('locate-provider-thresh99', '/v1/chat/completions', {
  model: 'scaledown/extract',
  messages: [{ role: 'user', content: doc }],
  provider: { options: { scaledown: { entities, threshold: 0.99, context_chars: 500 } } },
});

// ---------------------------------------------------------------- 2. json_schema shape
const c = await call('locate-json-schema', '/v1/chat/completions', {
  model: 'scaledown/extract',
  messages: [{ role: 'user', content: doc }],
  response_format: { type: 'json_schema', json_schema: { name: 'lease', schema: { type: 'object', properties: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, { type: 'string', description: v.description }])) } } },
});

// ---------------------------------------------------------------- 3. decisions
const d = await call('decide-alpha', '/alpha/decisions', {
  model: 'classify-1',
  state: { text: `${doc}\n\nQUESTION CONTEXT: the lease is a ten year term from 1 April 2024, with no break option and no insurance figure.` },
  questions: {
    has_insurance_figure: { type: 'choice', instructions: 'Does the document state an annual insurance premium?', criteria: { yes: 'the document states an insurance premium amount', no: 'the document states that no premium applies', insufficient_evidence: 'the document does not mention insurance at all' } },
    term_exceeds_five_years: { type: 'choice', instructions: 'Is the term longer than five years?', criteria: { yes: 'the stated term is more than five years', no: 'the stated term is five years or less', insufficient_evidence: 'no term is stated' } },
  },
});

// ---------------------------------------------------------------- summary
const entsOf = (r) => r?.json?.choices?.[0]?.message?.content ? (() => { try { return JSON.parse(r.json.choices[0].message.content).entities ?? []; } catch { return []; } })() : [];

for (const [label, r] of [['provider.options threshold=0', a], ['provider.options threshold=0.99', b], ['json_schema', c]]) {
  const e = entsOf(r);
  console.log(`\n${label}: ${e.length} entities`);
  for (const x of e) console.log(`   ${String(x.type ?? x.name ?? '?').padEnd(20)} ${JSON.stringify(String(x.text ?? x.value)).slice(0, 40)} conf=${x.confidence}`);
}
console.log('\nprovider.options answer keys:', JSON.stringify(Object.keys(a?.json?.choices?.[0]?.message ?? {})));
console.log('provider.options content (first 400):', String(a?.json?.choices?.[0]?.message?.content ?? '').slice(0, 400));
console.log('provider.options node present:', Boolean(a?.json?.choices?.[0]?.message?.annotations ?? a?.json?.node));
console.log('\ndecisions raw (first 800):', JSON.stringify(d?.json).slice(0, 800));
console.log(`\nspent $${spent.toFixed(6)} of $${BUDGET}`);
