#!/usr/bin/env node
// Sliding-window extraction: chunk a long document, extract per window, re-map spans to the
// document, merge across overlapping windows, and resolve conflicts.
//
//   OPENROUTER_API_KEY=... node extract-test/verify-tmp/chunk-remap.mjs \
//     --docs extract-test/docs/legal-property --limit 1 --chunk 8000 --overlap 1600 --header 4000
//   node extract-test/verify-tmp/chunk-remap.mjs --replay   # re-merge recorded responses, no API
//
// Each design decision below answers a measured failure from this session:
//  - entities is a MAP keyed by field, not a list of {name, description} (a list returns nothing);
//  - the payload is choices[0].message.content, a JSON string, not choices.message.entities;
//  - windows overlap and end on line breaks where possible;
//  - every window but the first carries the opening `--header` chars, because a window that opens
//    mid-contract has no Landlord/Tenant definitions and returned 0 entities without it
//    (measured: windows 1-3 empty on both leases, with "Security Deposit" sitting at char 10,749
//    inside window 1);
//  - offsets are re-derived by re-locating the returned text in the whole document, because
//    chunk_offset + span_offset only works if `start` is a true span, and most are not;
//  - dedup keys on the RE-LOCATED position, so a value seen in several windows collapses;
//  - "null"/"none"/"n/a" are absence, not values: the preamble run returned literal "null"
//    strings for fields that are not in that window;
//  - a field answered with more than one grounded text is reported as a conflict with its
//    alternatives, never silently resolved to one answer.

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const KEY = process.env.OPENROUTER_API_KEY || process.env.SCALEDOWN_API_KEY;
const API = 'https://openrouter.ai/api';
const OUT = 'extract-test/out/chunk-remap';
const DOCS = arg('docs', 'extract-test/docs/legal-property');
const LIMIT = Number(arg('limit', '2'));
const CHUNK = Number(arg('chunk', '20000'));
const OVERLAP = Number(arg('overlap', '2000'));
const HEADER = Number(arg('header', '0'));
const BUDGET = Number(arg('budget', '0.02'));
const REPLAY = argv.includes('--replay');

if (!REPLAY && !KEY) { console.error('no key'); process.exit(2); }
if (!(OVERLAP >= 0 && OVERLAP < CHUNK)) {
  console.error(`overlap must satisfy 0 <= overlap < chunk (got ${OVERLAP} / ${CHUNK}); equal values never advance`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const FIELDS = {
  landlord_name: 'Find the full legal name of the entity granting the lease, including any company or government suffix, exactly as written.',
  tenant_name: 'Find the full legal name of the entity taking the lease, including any company suffix, exactly as written.',
  premises_address: 'Find the postal address or legal description of the demised premises, exactly as written.',
  commencement_date: 'Find the date on which the lease term commences, as written in the document.',
  base_rent: 'Find the annual or monthly base rent figure stated in the rent clause, expressed as written, for example "one hundred thousand dollars ($100,000) per year"; do not normalise it.',
  security_deposit: 'Find the security deposit or letter of credit amount required under the lease, expressed as written.',
};

const ABSENT = new Set(['null', 'none', 'n/a', 'na', 'nil', 'unknown', 'not stated', 'not specified', 'not found', 'no', '']);
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// ---------------------------------------------------------------- windows

function windows(text, size = CHUNK, overlap = OVERLAP, header = HEADER) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const floor = start + Math.floor(size * 0.85);
      const nl = text.lastIndexOf('\n', end);
      if (nl > floor) end = nl + 1;
    }
    const prefix = start > 0 && header > 0 ? text.slice(0, header) : '';
    out.push({ index: out.length, start, end, text: text.slice(start, end), prefix });
    if (end >= text.length) break;
    const next = end - overlap;
    start = next > start ? next : start + (size - overlap);
  }
  return out;
}

// ---------------------------------------------------------------- re-mapping

function normalised(text) {
  let norm = '';
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (prevSpace) continue;
      norm += ' ';
      map.push(i);
      prevSpace = true;
    } else {
      norm += c.toLowerCase();
      map.push(i);
      prevSpace = false;
    }
  }
  return { norm, map };
}

function locate(text, span, win, pre) {
  const s = String(span ?? '');
  if (!s.trim()) return { ok: false, how: 'empty' };

  const from = Math.max(0, win.start - s.length);
  const inWindow = text.indexOf(s, from);
  if (inWindow !== -1 && inWindow <= win.end) return { ok: true, how: 'window', start: inWindow, end: inWindow + s.length };

  const anywhere = text.indexOf(s);
  if (anywhere !== -1) return { ok: true, how: 'document', start: anywhere, end: anywhere + s.length };

  const needle = collapse(s);
  const at = pre.norm.indexOf(needle);
  if (at !== -1) {
    return { ok: true, how: 'canonicalised', start: pre.map[at], end: pre.map[at + needle.length - 1] + 1 };
  }
  return { ok: false, how: 'absent' };
}

// ---------------------------------------------------------------- merge

/**
 * Turn per-window entity lists into one record per field.
 * Grounded candidates are voted on by normalised text; the most-supported one wins, ties break to
 * the longest text (the most complete as-written form) and then the earliest position.
 */
function merge(doc, perWindow) {
  const pre = normalised(doc);
  const dedup = new Map();     // field|norm|position -> candidate
  const absentSightings = {};  // field -> count of "null"/"none" answers
  const ungrounded = [];       // claimed values with no home in the document

  for (const { win, entities } of perWindow) {
    for (const item of entities) {
      const field = item.type ?? item.name ?? '';
      const span = String(item.text ?? '');
      if (ABSENT.has(collapse(span))) { absentSightings[field] = (absentSightings[field] ?? 0) + 1; continue; }

      const loc = locate(doc, span, win, pre);
      if (!loc.ok) {
        ungrounded.push({ field, text: span, confidence: item.confidence ?? null, in_window: win.index });
        continue;
      }
      const key = `${field}|${collapse(span)}|${loc.start}`;
      const existing = dedup.get(key);
      if (existing) { existing.votes++; existing.windows.push(win.index); continue; }
      dedup.set(key, {
        field,
        text: span,
        norm: collapse(span),
        global_start: loc.start,
        global_end: loc.end,
        re_located_by: loc.how,
        returned_offset: item.start ?? null,
        offset_was_correct: item.start === loc.start - win.start + win.prefix.length,
        confidence: item.confidence ?? null,
        votes: 1,
        windows: [win.index],
      });
    }
  }

  const byField = {};
  for (const c of dedup.values()) (byField[c.field] ??= []).push(c);

  const fields = {};
  for (const field of Object.keys(FIELDS)) {
    const candidates = (byField[field] ?? []).sort(
      (a, b) => b.votes - a.votes || b.norm.length - a.norm.length || a.global_start - b.global_start,
    );
    if (!candidates.length) {
      fields[field] = { status: absentSightings[field] ? 'absent' : 'missing', absent_sightings: absentSightings[field] ?? 0 };
      continue;
    }
    const [best, ...rest] = candidates;
    fields[field] = {
      status: rest.length ? 'conflict' : 'ok',
      text: best.text,
      global_start: best.global_start,
      global_end: best.global_end,
      votes: best.votes,
      confidence: best.confidence,
      re_located_by: best.re_located_by,
      offset_was_correct: best.offset_was_correct,
      alternatives: rest.map((c) => ({ text: c.text, at: c.global_start, votes: c.votes })),
      absent_sightings: absentSightings[field] ?? 0,
    };
  }

  const values = Object.values(fields).filter((f) => f.status === 'ok' || f.status === 'conflict');
  return {
    fields,
    values_total: values.length,
    resolved: values.filter((f) => f.status === 'ok').length,
    conflicts: values.filter((f) => f.status === 'conflict').length,
    absent: Object.values(fields).filter((f) => f.status === 'absent').length,
    missing: Object.values(fields).filter((f) => f.status === 'missing').length,
    ungrounded_claims: ungrounded,
    positions_recovered_by_search: values.filter((f) => f.re_located_by !== 'window').length,
    returned_offsets_wrong: values.filter((f) => f.offset_was_correct === false).length,
  };
}

function printDocument(file, doc, merged, perWindow, note) {
  console.log(`\n=== ${file}  ${doc.length} chars  ${note}`);
  for (const w of perWindow) {
    console.log(`  win ${w.window} [${w.start}:${w.end}]${w.prefix ? ` +${w.prefix}h` : ''} ${w.status} -> ${w.entities} entities`);
  }
  for (const [field, f] of Object.entries(merged.fields)) {
    if (f.status === 'ok' || f.status === 'conflict') {
      const tag = f.status === 'conflict' ? `CONFLICT(${f.alternatives.length})` : 'ok';
      console.log(`  ${field.padEnd(18)} ${tag.padEnd(12)} ${JSON.stringify(f.text.slice(0, 62))} @ ${f.global_start}:${f.global_end} votes=${f.votes} via ${f.re_located_by}`);
      for (const a of f.alternatives) console.log(`      alt   ${JSON.stringify(a.text.slice(0, 62))} @ ${a.at} votes=${a.votes}`);
    } else {
      console.log(`  ${field.padEnd(18)} ${f.status.toUpperCase().padEnd(12)} ${f.absent_sightings ? `(${f.absent_sightings} "null" answers)` : ''}`);
    }
  }
  for (const u of merged.ungrounded_claims) console.log(`  ! ungrounded claim  ${u.field} = ${JSON.stringify(u.text)} (window ${u.in_window})`);
  console.log(`  -> ${merged.values_total}/6 fields answered, ${merged.resolved} unambiguous, ${merged.conflicts} conflicting, ${merged.absent} absent, ${merged.missing} missing`);
}

// ---------------------------------------------------------------- live

async function live() {
  const files = readdirSync(DOCS).filter((f) => f.endsWith('.txt')).sort().slice(0, LIMIT);
  if (!files.length) { console.error(`no .txt in ${DOCS}`); process.exit(2); }
  let spent = 0;
  const report = [];

  for (const file of files) {
    const doc = readFileSync(join(DOCS, file), 'utf8');
    const wins = windows(doc);
    const perWindow = [];
    const collected = [];

    for (const win of wins) {
      if (spent >= BUDGET) { console.error(`budget reached at window ${win.index}`); break; }
      const body = {
        model: 'scaledown/extract',
        messages: [{ role: 'user', content: win.prefix + win.text }],
        provider: {
          options: {
            scaledown: {
              entities: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, { description: v }])),
              threshold: 0,
              context_chars: 200,
            },
          },
        },
      };
      const t0 = performance.now();
      const res = await fetch(`${API}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const raw = await res.text();
      const ms = Math.round(performance.now() - t0);
      let json = null;
      try { json = JSON.parse(raw); } catch { /* keep null */ }
      spent += json?.usage?.cost ?? 0;

      let entities = [];
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content === 'string') {
        try { entities = JSON.parse(content).entities ?? []; } catch { /* not json */ }
      }
      const before = entities.length;
      writeFileSync(join(OUT, `${file.replace('.txt', '')}-win${win.index}.json`), JSON.stringify({
        file, window: [win.start, win.end], prefix_chars: win.prefix.length,
        status: res.status, ms, cost: json?.usage?.cost ?? 0, count: before, request: body, response: json ?? raw,
      }, null, 2));
      perWindow.push({ window: win.index, start: win.start, end: win.end, prefix: win.prefix.length, status: res.status, entities: before });
      collected.push({ win, entities });
    }

    const merged = merge(doc, collected);
    printDocument(file, doc, merged, perWindow, `chunk ${CHUNK} overlap ${OVERLAP} header ${HEADER}`);
    report.push({ document: file, chars: doc.length, windows: perWindow.length, spent, merged, per_window: perWindow });
  }

  const summary = { mode: 'live', params: { CHUNK, OVERLAP, HEADER, LIMIT, BUDGET }, spent, documents: report };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nspend $${spent.toFixed(7)} across ${report.reduce((n, r) => n + r.windows, 0)} calls | summary -> ${OUT}/summary.json`);
}

// ---------------------------------------------------------------- replay

function replay() {
  if (!existsSync(OUT)) { console.error(`nothing recorded in ${OUT}`); process.exit(2); }
  const stems = [...new Set(readdirSync(OUT).filter((f) => f.includes('-win')).map((f) => f.split('-win')[0]))]
    .filter((s) => existsSync(join(DOCS, `${s}.txt`)));
  const report = [];

  for (const stem of stems) {
    const file = `${stem}.txt`;
    const doc = readFileSync(join(DOCS, file), 'utf8');
    const rows = readdirSync(OUT)
      .filter((f) => f.startsWith(`${stem}-win`) && f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8')))
      .filter((r) => Array.isArray(r.window))
      .sort((a, b) => a.window[0] - b.window[0]);

    const perWindow = rows.map((row) => {
      const content = row.response?.choices?.[0]?.message?.content;
      let entities = [];
      if (typeof content === 'string') { try { entities = JSON.parse(content).entities ?? []; } catch { /* not json */ } }
      return {
        win: { index: rows.indexOf(row), start: row.window[0], end: row.window[1], prefix: 'x'.repeat(row.prefix_chars ?? 0) },
        entities,
        meta: { window: rows.indexOf(row), start: row.window[0], end: row.window[1], prefix: row.prefix_chars ?? 0, status: row.status, entities: entities.length },
      };
    });

    const merged = merge(doc, perWindow);
    const meta = perWindow.map((p) => ({ ...p.meta, duplicates: 0 }));
    printDocument(file, doc, merged, meta, `replay of ${rows.length} recorded windows (no API)`);
    report.push({ document: file, chars: doc.length, windows: rows.length, merged, per_window: meta });
  }

  writeFileSync(join(OUT, 'summary-replay.json'), JSON.stringify({ mode: 'replay', documents: report }, null, 2));
  console.log(`\nreplay: 0 calls, $0.0000000 | summary -> ${OUT}/summary-replay.json`);
}

if (REPLAY) replay(); else await live();
