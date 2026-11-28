#!/usr/bin/env node
// Sliding-window extraction on POST /api/alpha/extractions (typed fields, Unicode code-point spans).
//
//   node extract-test/verify-tmp/extract-alpha.mjs --doc <file> --size 3000 --overlap 300 --header 3000
//
// Each rule below answers something measured on this route, not a guess:
//  - a missing span is NOT a reason to drop a value. The docs state that ScaleDown omits `span`
//    when its offsets don't delimit the returned text (an entity crossing a line break, whitespace
//    normalised), so the value is re-located in the window body instead of being sent to review;
//  - `span` is validated as nullable, not only optional: a `span: null` would abort Response.parse
//    in a strict schema and lose the whole document;
//  - absence is `value: null` (observed) or the literal strings Extract can return;
//  - `--header N` prepends the opening N code points to every window but the first, because a
//    window opening mid-contract has no Landlord/Tenant definitions and returns no entities;
//  - a match inside that preamble is NOT evidence for the window: without this rule one value at
//    character 112 collected 22 votes from 22 windows that had merely re-read the preamble;
//  - all offsets are code points (Array.from + index arithmetic over the code-point array), and
//    dedup keys on the re-located global position, so one value seen in overlapping windows merges;
//  - usage.cost is summed, so spend is measured rather than estimated.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const DOC = arg('doc', 'extract-test/docs/legal-property/01-property-lease.txt');
const SIZE = Number(arg('size', '3000'));
const OVERLAP = Number(arg('overlap', '300'));
const HEADER = Number(arg('header', '0'));
const OUT = arg('out', 'extract-test/out/extract-alpha');
const SPEC = arg('fields', 'invoice_number:Find the invoice number or reference.|effective_date:Find the execution or effective date in the text.');
const MODEL = arg('model', 'scaledown/extract');

const fields = {};
for (const s of SPEC.split('|')) { const at = s.indexOf(':'); fields[s.slice(0, at)] = { type: 'text', instructions: s.slice(at + 1) }; }

const ABSENT = new Set(['null', 'none', 'n/a', 'na', 'nil', 'unknown', 'not stated', 'not specified', 'not found', '']);
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function windows(points, size, overlap, header) {
  const out = [];
  for (let start = 0; start < points.length; start += size - overlap) {
    const end = Math.min(start + size, points.length);
    const prefix = start > 0 && header > 0 ? points.slice(0, header) : [];
    out.push({ index: out.length, start, end, prefix, text: prefix.join('') + points.slice(start, end).join('') });
    if (end >= points.length) break;
  }
  return out;
}

/** Whitespace-collapsed, lower-cased view of a code-point array, with a map back to its indices. */
function normalised(points) {
  let norm = ''; const map = []; let prevSpace = false;
  for (let i = 0; i < points.length; i++) {
    const c = points[i];
    if (/\s/.test(c)) { if (prevSpace) continue; norm += ' '; map.push(i); prevSpace = true; }
    else { norm += c.toLowerCase(); map.push(i); prevSpace = false; }
  }
  return { norm, map };
}

/** Exact-then-canonicalised search INSIDE one window body. Nothing outside the body is evidence. */
function locateInBody(points, value, win) {
  const body = points.slice(win.start, win.end);
  const needle = String(value);
  const np = Array.from(needle);
  for (let i = 0; i + np.length <= body.length; i++) {
    if (body[i] === np[0] && body.slice(i, i + np.length).join('') === needle) {
      return { ok: true, how: 'body', start: win.start + i, end: win.start + i + np.length };
    }
  }
  const n = normalised(body);
  const target = collapse(needle);
  const ni = n.norm.indexOf(target);
  if (ni !== -1) return { ok: true, how: 'body-canonicalised', start: win.start + n.map[ni], end: win.start + n.map[ni + target.length - 1] + 1 };
  return { ok: false, how: 'not-in-body' };
}

async function call(state) {
  const res = await fetch('https://openrouter.ai/api/alpha/extractions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, fields }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json().catch(async () => ({ non_json: await res.text() }));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  if (body.truncated) throw new Error('truncated: true — reduce --size');
  return body;
}

const points = Array.from(readFileSync(DOC, 'utf8'));
const wins = windows(points, SIZE, OVERLAP, HEADER);

let cost = 0, calls = 0, spanPresent = 0, spanAbsent = 0, spanUnusable = 0, fromPreamble = 0, notInBody = 0;
const dedup = new Map(); const absentSightings = {}; const ungrounded = []; const perWindow = [];

for (const win of wins) {
  const body = await call(win.text);
  calls++; cost += body.usage?.cost ?? 0;
  const prefixLen = win.prefix.length;
  const answers = body.answers ?? {};
  let kept = 0;

  for (const [field, a] of Object.entries(answers)) {
    const value = a.value;
    if (value === null || ABSENT.has(collapse(value))) { absentSightings[field] = (absentSightings[field] ?? 0) + 1; continue; }
    const text = String(value);
    if (a.span == null) spanAbsent++; else spanPresent++;

    let loc = null;
    if (a.span && a.span[0] >= 0 && a.span[1] > a.span[0] && win.text.slice(a.span[0], a.span[1]) === text) {
      const start = a.span[0] - prefixLen;
      if (start >= 0) loc = { ok: true, how: 'span', start: win.start + start, end: win.start + start + (a.span[1] - a.span[0]) };
      else fromPreamble++;   // the span indexes the prepended preamble: the preamble answered, not this window
    } else if (a.span != null) spanUnusable++;

    // Body search is authoritative: a value the preamble merely repeated belongs to the preamble's
    // window, and counting it here is how 22 windows "voted" for one sighting at character 112.
    if (!loc) loc = locateInBody(points, text, win);
    if (!loc.ok) {
      if (fromPreamble === 0 || loc.how === 'not-in-body') notInBody++;
      ungrounded.push({ field, text, window: win.index, confidence: a.confidence ?? null, how: loc.how });
      continue;
    }

    const key = `${field}|${collapse(text)}|${loc.start}`;
    const prev = dedup.get(key);
    if (prev) { prev.votes++; prev.windows.push(win.index); continue; }
    dedup.set(key, { field, text, global_start: loc.start, global_end: loc.end, re_located_by: loc.how, confidence: a.confidence ?? null, votes: 1, windows: [win.index] });
    kept++;
  }
  perWindow.push({ window: win.index, start: win.start, end: win.end, prefix_chars: prefixLen, answers, kept });
}

const byField = {};
for (const c of dedup.values()) (byField[c.field] ??= []).push(c);
const resolved = {};
for (const field of Object.keys(fields)) {
  const cands = (byField[field] ?? []).sort((a, b) => b.votes - a.votes || b.norm?.length - a.norm?.length || a.global_start - b.global_start);
  if (!cands.length) { resolved[field] = { status: absentSightings[field] ? 'absent' : 'missing', absent_sightings: absentSightings[field] ?? 0 }; continue; }
  const [best, ...rest] = cands;
  resolved[field] = {
    status: rest.length ? 'conflict' : 'ok',
    text: best.text, global_start: best.global_start, global_end: best.global_end,
    votes: best.votes, confidence: best.confidence, re_located_by: best.re_located_by,
    alternatives: rest.map((c) => ({ text: c.text, at: c.global_start, votes: c.votes })),
    absent_sightings: absentSightings[field] ?? 0,
  };
}

const found = Object.values(resolved).filter((f) => f.status === 'ok' || f.status === 'conflict');
const summary = {
  doc: DOC, model: MODEL, chars: points.length, windows: wins.length, calls,
  cost_usd: Number(cost.toFixed(8)), size: SIZE, overlap: OVERLAP, header: HEADER,
  fields_answered: `${found.length}/${Object.keys(fields).length}`,
  spans_present: spanPresent, spans_absent: spanAbsent, spans_present_but_unusable: spanUnusable,
  answered_from_preamble: fromPreamble, values_without_a_body_match: notInBody,
  per_window_kept: perWindow.map((w) => w.kept),
  resolved, ungrounded_claims: ungrounded,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/alpha-${SIZE}-${OVERLAP}-h${HEADER}.json`, JSON.stringify({ summary, perWindow }, null, 1));
console.log(JSON.stringify(summary, null, 1));
