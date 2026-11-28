#!/usr/bin/env node
// Second acquisition pass: EDGAR full-text search with lease-specific language, plus a mechanical
// "is this actually a lease of premises" filter, plus a log of every rejection.
//
//   node extract-test/verify-tmp/fetch-leases.mjs
//
// The first pass (fetch-docs.mjs) produced: a letter about leases, an equipment lease, a
// bond-financed lease and an amendment. None carried the brief's field set. That precision failure
// is recorded in extract-test/docs/legal-rejections.json rather than hidden by re-querying.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const UA = { 'User-Agent': 'independent-verification-brief research@example.com', accept: 'text/html' };
const OUT = 'extract-test/docs/legal-property';
mkdirSync(OUT, { recursive: true });
const manifest = [];
const rejections = [];

const QUERIES = ['"demised premises"', '"base rent" "landlord" "tenant"', '"lease term" "security deposit"'];

function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function get(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, text: buf.toString('utf8') };
}

// A lease of premises, mechanically: the words that only appear in one, and not the ones that mean
// it is equipment or a letter about leases.
const has = (t, re) => re.test(t);
function classify(text) {
  const reasons = [];
  const score = [
    ['demised premises|premises', /demised premises|the premises/gi],
    ['landlord', /landlord/gi],
    ['tenant', /tenant/gi],
    ['rent', /\b(base rent|basic rent|minimum rent|annual rent)\b/gi],
    ['term', /\b(term of|lease term|initial term)\b/gi],
    ['premises address', /\b(square feet|sq\.? ?ft|street|avenue|road|suite|park)\b/gi],
  ].map(([label, re]) => {
    const n = (text.match(re) ?? []).length;
    if (n < 2) reasons.push(`only ${n} × ${label}`);
    return n >= 2;
  });
  const equipment = /equipment lease|lessor hereby leases.*equipment/i.test(text.slice(0, 4000));
  const letter = /^\s*Dear |sincerely|very truly yours/i.test(text.slice(0, 3000)) && !/landlord/i.test(text);
  if (equipment) reasons.push('equipment lease');
  if (letter) reasons.push('a letter, not a lease');
  const ok = score.filter(Boolean).length >= 5 && !equipment && !letter;
  return { ok, reasons, hits: score.filter(Boolean).length };
}

const seen = new Set();
let n = 0;
for (const q of QUERIES) {
  if (n >= 6) break;
  const res = await get(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=8-K`);
  if (res.status !== 200) { console.log(`FTS ${q} HTTP ${res.status}`); continue; }
  let hits = [];
  try { hits = JSON.parse(res.text).hits?.hits ?? []; } catch { console.log(`FTS ${q} unparseable`); continue; }
  for (const h of hits) {
    if (n >= 6) break;
    const [accession, file] = String(h._id).split(':');
    if (!accession || !file || seen.has(file)) continue;
    seen.add(file);
    const cik = String(Number(h._source.ciks[0]));
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${file}`;
    try {
      const d = await get(url);
      if (d.status !== 200) { rejections.push({ url, reason: `HTTP ${d.status}` }); continue; }
      const text = strip(d.text);
      const c = classify(text);
      if (!c.ok) { rejections.push({ url, query: q, chars: text.length, reason: c.reasons.join('; ') }); console.log(`  reject ${file}: ${c.reasons.join('; ')}`); continue; }
      const body = text.length > 60000 ? `${text.slice(0, 60000)}\n\n[TRUNCATED at 60000 of ${text.length}]` : text;
      const name = `${String(++n).padStart(2, '0')}-property-lease.txt`;
      writeFileSync(join(OUT, name), body);
      manifest.push({ kind: 'legal', name, url, cik, accession, query: q, source_bytes: d.buf.length, chars_kept: body.length, chars_total: text.length, sha256: createHash('sha256').update(body).digest('hex'), provenance: 'public — SEC EDGAR', filter: c.hits });
      console.log(`  keep   ${name}  ${body.length} chars  filter ${c.hits}/6  ${file}`);
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) { rejections.push({ url, reason: e.message }); }
  }
}

writeFileSync(join('extract-test/docs', 'manifest-property.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join('extract-test/docs', 'legal-rejections.json'), JSON.stringify(rejections, null, 2));
console.log(`\nkept ${manifest.length}, rejected ${rejections.length}`);
