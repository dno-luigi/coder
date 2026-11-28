#!/usr/bin/env node
// Three-layer test harness: locate (extract) -> decide (classify-1) -> reconcile (deterministic).
// Implements the metrics the brief asks for, and nothing else.
//
//   node extract-test/run.mjs --vertical legal   --docs extract-test/docs/legal-property --out extract-test/out/legal
//   node extract-test/run.mjs --vertical denial  --docs extract-test/docs/medical-denials --out extract-test/out/denial
//   node extract-test/run.mjs --vertical priorauth --docs extract-test/docs/medical-notes --out extract-test/out/priorauth
//
// Rules carried from the brief:
//  - zero entities on a document that should contain fields is a FAILURE, retried once with reworded
//    field descriptions, then recorded as failed;
//  - a decision is not asked without its `requires` fields present; a missing requirement forces
//    `insufficient_evidence` rather than letting absence read as negation;
//  - cost is taken from the response's own usage, never estimated;
//  - every request body and raw response is written to out/, one file per call.

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const VERTICAL = arg('vertical', 'legal');
const DOCS = arg('docs');
const OUT = arg('out', `extract-test/out/${VERTICAL}`);
const BUDGET = Number(arg('budget', '0.05'));
const GATE = Number(arg('gate', '0.6'));
const GOLD = arg('gold');
const KEY = process.env.OPENROUTER_API_KEY || process.env.SCALEDOWN_API_KEY;
const API = 'https://openrouter.ai/api';

if (!KEY) { console.error('no key'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- vertical configs

const CONFIG = {
  legal: {
    // Six fields, one call: more than six starts to hit the provider's output budget.
    fields: {
      landlord_name: 'Find the full legal name of the entity granting the lease, including any company or government suffix, exactly as written.',
      tenant_name: 'Find the full legal name of the entity taking the lease, including any company suffix, exactly as written.',
      premises_address: 'Find the postal address or legal description of the demised premises, exactly as written.',
      commencement_date: 'Find the date on which the lease term commences, as written in the document.',
      base_rent: 'Find the annual or monthly base rent figure stated in the rent clause, expressed as written, for example "one hundred thousand dollars ($100,000) per year"; do not normalise it.',
      security_deposit: 'Find the security deposit or letter of credit amount required under the lease, expressed as written.',
    },
    decisions: {
      is_premises_lease: { instructions: 'Is this document a lease of real property premises, rather than an equipment lease, a letter about leases, or a financing document?', criteria: { yes: 'the document grants a leasehold interest in identified premises', no: 'the document leases equipment, or is not a lease', insufficient_evidence: 'the document does not identify what is being leased' }, requires: [] },
      term_over_five_years: { instructions: 'Is the stated lease term longer than five years?', criteria: { yes: 'a term longer than five years is stated', no: 'a term of five years or less is stated', insufficient_evidence: 'no term, or only an extension mechanism, is stated' }, requires: ['commencement_date'] },
      tenant_may_terminate_early: { instructions: 'Does the tenant have an express right to terminate the lease early?', criteria: { yes: 'an early termination or break right is granted to the tenant', no: 'the document states there is no early termination right', insufficient_evidence: 'the document does not address early termination' }, requires: [] },
    },
  },
  denial: {
    fields: {
      claim_id: 'Find the claim number or claim identifier the payer assigned, exactly as written.',
      date_of_service: 'Find the date of service the denial refers to, exactly as written.',
      carc_code: 'Find each claim adjustment reason code (CARC) applied, exactly as written, for example "CARC 16".',
      billed_amount: 'Find the total amount billed, expressed as written, including the currency symbol.',
      allowed_amount: 'Find the allowed amount, expressed as written; if the payer allowed nothing, return the zero amount as written.',
      appeal_deadline: 'Find the last date on which an appeal may be filed, as written; compute it only if the letter states a filing window in days from the letter date.',
    },
    decisions: {
      denial_is_appealable: { instructions: 'On the face of this letter, is the denial appealable by the provider?', criteria: { yes: 'the letter gives a denial reason that a provider can rebut with clinical or coding evidence', no: 'the letter states the claim is not appealable or the time to appeal has passed', insufficient_evidence: 'the letter does not state a denial reason or an appeal right' }, requires: ['carc_code', 'date_of_service'] },
      appeal_window_open: { instructions: 'Is the appeal filing window still open as at the letter date?', criteria: { yes: 'the appeal deadline is on or after the letter date', no: 'the appeal deadline has already passed', insufficient_evidence: 'no deadline or filing window is stated' }, requires: ['appeal_deadline'] },
    },
    reconcile: (fields, text) => {
      const num = (s) => { const m = String(s ?? '').replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
      const billed = num(fields.billed_amount?.[0]?.text);
      const allowed = num(fields.allowed_amount?.[0]?.text);
      const out = { billed, allowed };
      if (billed !== null && allowed !== null) {
        out.calculated_denial = Math.round((billed - allowed) * 100) / 100;
        const stated = text.match(/denied amount[^$]{0,40}\$?([\d,]+\.?\d{0,2})/i);
        out.stated_denial = stated ? Number(stated[1].replace(/,/g, '')) : null;
        out.denial_matches = out.stated_denial === null ? null : Math.abs(out.calculated_denial - out.stated_denial) < 0.02;
      }
      return out;
    },
  },
  case: {
    // A judicial opinion is the hardest legal test of the literal/derived split: it states its own
    // holding, so what looks like a 'derived' field may be present verbatim in the syllabus.
    fields: {
      case_name: 'Find the name of the case as reported, exactly as written, including the parties.',
      citation: 'Find the United States Reports citation for this case, exactly as written, for example "422 U.S. 806".',
      court: 'Find the name of the court that decided this case, exactly as written.',
      decision_date: 'Find the date on which the court decided the case, as written in the headnote or at the end of the opinion.',
      authoring_justice: 'Find the name of the justice who delivered the opinion of the Court, exactly as written.',
      disposition: 'Find the disposition of the judgment under review — what the court did with the decision below, as written, for example "reversed and remanded".',
    },
    decisions: {
      petitioner_got_relief: { instructions: 'Did the petitioner obtain the relief sought — was the judgment under review reversed or vacated in his favour?', criteria: { yes: 'the judgment below was reversed, vacated or remanded for further proceedings consistent with the opinion', no: 'the judgment below was affirmed', insufficient_evidence: 'the disposition cannot be determined from the document' }, requires: ['disposition'] },
      self_representation_right_recognised: { instructions: 'Did the Court recognise a constitutional right of a criminal defendant to represent himself?', criteria: { yes: 'the Court holds that a defendant may proceed without counsel when he elects to do so', no: 'the Court holds that counsel cannot be waived or that no such right exists', insufficient_evidence: 'the opinion does not reach the question' }, requires: [] },
      dissent_exists: { instructions: 'Was a dissenting opinion filed?', criteria: { yes: 'one or more justices dissented', no: 'the decision was unanimous and the document says so', insufficient_evidence: 'the document does not show whether any justice dissented' }, requires: [] },
    },
  },
  priorauth: {
    fields: {
      patient_age: 'Find the patient age in years, exactly as written.',
      diagnosis: 'Find the diagnosis or indication for the requested service, exactly as written.',
      requested_service: 'Find the service being requested, exactly as written.',
      prior_treatment: 'Find any conservative or prior treatment already tried for this condition, exactly as written.',
      severity_finding: 'Find any measured severity finding, such as an apnoea-hypopnoea index or oxygen saturation, exactly as written.',
    },
    criteria: {
      A_age_over_18: { instructions: 'Is the patient 18 years of age or older?', criteria: { met: 'the note states an age of 18 or more', not_met: 'the note states an age below 18', insufficient_evidence: 'the note does not state an age' }, requires: ['patient_age'] },
      B_diagnosis_supported: { instructions: 'Does the note establish a diagnosis of obstructive sleep apnoea in an adult?', criteria: { met: 'the note states a diagnosis of obstructive sleep apnoea', not_met: 'the note states a different diagnosis', insufficient_evidence: 'the note records symptoms but no diagnosis' }, requires: ['diagnosis'] },
      C_severity_documented: { instructions: 'Is severity documented by a measured finding (AHI or oxygen saturation)?', criteria: { met: 'a measured AHI or oxygen desaturation value is recorded', not_met: 'the note states severity without any measured value', insufficient_evidence: 'no severity information appears' }, requires: ['severity_finding'] },
      D_conservative_treatment: { instructions: 'Has conservative treatment been tried, where the policy requires it?', criteria: { met: 'the note records prior conservative treatment', not_met: 'the note states no conservative treatment was tried', insufficient_evidence: 'the note does not address prior treatment' }, requires: ['prior_treatment'] },
    },
    reconcile: () => ({}),
  },
};

const cfg = CONFIG[VERTICAL];
if (!cfg) { console.error(`unknown vertical ${VERTICAL}`); process.exit(2); }
if (!DOCS || !existsSync(DOCS)) { console.error(`no docs at ${DOCS}`); process.exit(2); }

// ---------------------------------------------------------------- api

let spent = 0;
const calls = [];

async function post(name, path, body) {
  if (spent >= BUDGET) return { skipped: 'budget' };
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = JSON.parse(raw); } catch { /* keep null */ }
  const cost = json?.usage?.cost ?? 0;
  spent += cost;
  const row = { name, path, status: res.status, ms, cost, body, response: json ?? raw };
  calls.push(row);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(row, null, 2));
  return row;
}

const entitiesOf = (row) => {
  const c = row?.response?.choices?.[0]?.message?.content;
  if (!c) return [];
  try { return JSON.parse(c).entities ?? []; } catch { return []; }
};

async function locate(doc, fields) {
  const body = {
    model: 'scaledown/extract',
    messages: [{ role: 'user', content: doc }],
    provider: { options: { scaledown: { entities: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { description: v }])), threshold: 0, context_chars: 200 } } },
  };
  let row = await post('locate', '/v1/chat/completions', body);
  let ents = entitiesOf(row);
  // The zero-entity cliff: retry once with the field key reworded as a full instruction.
  let retried = false;
  if (!ents.length && row.status === 200) {
    retried = true;
    const reworded = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `Find ${v.replace(/^Find /i, '')} Answer only with text that appears verbatim in the document.`]));
    row = await post('locate-retry', '/v1/chat/completions', { ...body, provider: { options: { scaledown: { entities: Object.fromEntries(Object.entries(reworded).map(([k, v]) => [k, { description: v }])), threshold: 0, context_chars: 200 } } } });
    ents = entitiesOf(row);
  }
  const byType = {};
  for (const e of ents) (byType[e.type] ??= []).push(e);
  return { row, byType, retried, zero: ents.length === 0 };
}

async function decide(doc, questions, present, fields) {
  const asked = {};
  const forced = {};
  for (const [name, q] of Object.entries(questions)) {
    const missing = (q.requires ?? []).filter((f) => !present.includes(f));
    if (missing.length) forced[name] = { choice: 'insufficient_evidence', confidence: null, forced_by: `missing ${missing.join(', ')}` };
    else asked[name] = { type: 'choice', instructions: q.instructions, criteria: q.criteria };
  }
  if (!Object.keys(asked).length) return { answers: forced, row: null };
  const row = await post('decide', '/alpha/decisions', {
    model: 'classify-1',
    state: { text: buildState(doc, fields) },
    questions: asked,
  });
  const answers = { ...forced };
  for (const [k, v] of Object.entries(row.response?.answers ?? {})) answers[k] = { choice: v.choice, confidence: v.confidence, probabilities: v.probabilities };
  return { answers, row };
}

// The brief's state-assembly fix: a header of every extracted value, then equal per-value windows
// centred on the value, deduplicated and in document order. No whole-document truncation, because
// truncation drops fields silently and that failure looks like a wrong decision later.
function buildState(doc, fields, window = 700, cap = 28000) {
  const header = Object.entries(fields)
    .filter(([, vs]) => vs.length)
    .map(([f, vs]) => `- ${f}: ${vs.map((v) => `${JSON.stringify(v.text)}${v.verbatim ? ' [verbatim]' : ' [NOT verbatim]'}`).join(' | ')}`)
    .join('\n');
  const spans = [];
  for (const vs of Object.values(fields)) {
    for (const v of vs) {
      if (typeof v.start !== 'number') continue;
      spans.push({ start: Math.max(0, v.start - window), end: Math.min(doc.length, (v.start + String(v.text).length) + window) });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  let body = '';
  for (const s of merged) {
    const piece = doc.slice(s.start, s.end);
    if (body.length + piece.length > cap) break;
    body += `\n[chars ${s.start}-${s.end}]\n${piece}\n`;
  }
  return `EXTRACTED VALUES:\n${header || '(none)'}\n\nEVIDENCE WINDOWS (${merged.length} windows, ${body.length} chars):\n${body}`;
}

// ---------------------------------------------------------------- run

const files = readdirSync(DOCS).filter((f) => f.endsWith('.txt')).sort();
const results = [];

for (const file of files) {
  const doc = readFileSync(join(DOCS, file), 'utf8');
  const { byType, zero } = await locate(doc, cfg.fields);
  const present = Object.keys(byType).filter((k) => (byType[k] ?? []).length);

  const fields = Object.fromEntries(present.map((k) => [k, byType[k].map((e) => ({
    text: String(e.text),
    confidence: e.confidence,
    verbatim: typeof e.start === 'number' && doc.slice(e.start, e.end) === e.text,
    also_in_doc: doc.includes(String(e.text)),
    start: e.start,
  }))]));

  const questions = cfg.decisions ?? cfg.criteria ?? {};
  const { answers } = Object.keys(questions).length ? await decide(doc, questions, present, fields) : { answers: {} };
  const reconciled = cfg.reconcile ? cfg.reconcile(fields, doc) : {};

  const escalations = Object.entries(answers).filter(([, a]) => a.choice === 'insufficient_evidence' || a.confidence === null || (typeof a.confidence === 'number' && a.confidence < GATE));

  results.push({
    file,
    chars: doc.length,
    zero_entities: zero,
    fields_expected: Object.keys(cfg.fields).length,
    fields_found: present.length,
    values_returned: Object.values(fields).flat().length,
    values_verbatim: Object.values(fields).flat().filter((v) => v.verbatim).length,
    fields,
    decisions: answers,
    escalations: escalations.map(([k, a]) => ({ question: k, choice: a.choice, confidence: a.confidence, forced_by: a.forced_by })),
    escalation_rate: Object.keys(answers).length ? escalations.length / Object.keys(answers).length : null,
    reconciled,
  });
  console.log(`${file}  ${doc.length} chars  fields ${present.length}/${Object.keys(cfg.fields).length}  verbatim ${Object.values(fields).flat().filter((v) => v.verbatim).length}/${Object.values(fields).flat().length}  decisions ${Object.keys(answers).length}  escalated ${escalations.length}${zero ? '  ZERO-ENTITY' : ''}`);
}

const summary = {
  vertical: VERTICAL,
  docs: files.length,
  docs_zero_entity: results.filter((r) => r.zero_entities).length,
  fields_expected: results.reduce((a, r) => a + r.fields_expected, 0),
  fields_found: results.reduce((a, r) => a + r.fields_found, 0),
  values_returned: results.reduce((a, r) => a + r.values_returned, 0),
  values_verbatim: results.reduce((a, r) => a + r.values_verbatim, 0),
  escalation_rate: (() => { const rs = results.filter((r) => r.escalation_rate !== null); return rs.length ? rs.reduce((a, r) => a + r.escalation_rate, 0) / rs.length : null; })(),
  cost_usd: Number(spent.toFixed(6)),
  calls: calls.length,
  gate: GATE,
};

// Gold scoring, and the only number the brief says it would kill a vertical over:
// wrong AND at or above the gate.
if (GOLD) {
  const goldAll = JSON.parse(readFileSync(GOLD, 'utf8'));
  const gold = goldAll[VERTICAL] ?? {};
  let total = 0;
  let correct = 0;
  let cw = 0;
  for (const r of results) {
    const g = gold[r.file];
    if (!g) { r.scored = null; continue; }
    const per = {};
    for (const [q, a] of Object.entries(r.decisions)) {
      const want = g[q];
      if (!want) continue;
      total += 1;
      const ok = a.choice === want;
      if (ok) correct += 1;
      const confident = typeof a.confidence === 'number' && a.confidence >= GATE;
      const wrongConfident = !ok && confident;
      if (wrongConfident) cw += 1;
      per[q] = { got: a.choice, want, confidence: a.confidence, correct: ok, confidently_wrong: wrongConfident };
    }
    r.scored = per;
  }
  summary.decisions_total = total;
  summary.decisions_correct = correct;
  summary.decisions_accuracy = total ? correct / total : null;
  summary.confidently_wrong = cw;
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify({ summary, results }, null, 2));
writeFileSync(join(OUT, 'calls.jsonl'), calls.map((c) => JSON.stringify({ name: c.name, status: c.status, ms: c.ms, cost: c.cost })).join('\n') + '\n');

console.log('\n' + JSON.stringify(summary, null, 2));
