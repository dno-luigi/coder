#!/usr/bin/env node
// Acquire an independent document set. Nothing here is authored by Agent 1.
//
//   node extract-test/verify-tmp/fetch-docs.mjs
//
// Legal: real exhibits from SEC EDGAR (public filings), fetched from the Archives and stripped to
// text. Medical: a public payer medical policy page (no PHI), plus synthetic notes authored later
// and labelled as synthetic.
//
// Writes extract-test/docs/{legal,medical}/*.txt and a manifest with source URL, CIK, accession,
// byte and character counts and a digest, so every document can be re-fetched and checked.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const UA = { 'User-Agent': 'independent-verification-brief research@example.com', accept: 'text/html,application/xhtml+xml' };
const LEGAL = 'extract-test/docs/legal';
const MED = 'extract-test/docs/medical';
mkdirSync(LEGAL, { recursive: true });
mkdirSync(MED, { recursive: true });

const manifest = [];

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
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
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

// ---------------------------------------------------------------- legal: EDGAR full-text search
const queries = [
  { q: '"lease agreement"', forms: '8-K', want: 4 },
  { q: '"credit agreement"', forms: '8-K', want: 2 },
];

const seen = new Set();
let n = 0;
for (const { q, forms, want } of queries) {
  const res = await get(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=${forms}`);
  if (res.status !== 200) { console.log(`FTS ${q} HTTP ${res.status}`); continue; }
  const hits = JSON.parse(res.text).hits?.hits ?? [];
  let taken = 0;
  for (const h of hits) {
    if (taken >= want) break;
    const [accession, file] = h._id.split(':');
    const cik = String(Number(h._source.ciks[0]));
    if (!accession || !file || seen.has(file)) continue;
    seen.add(file);
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${file}`;
    try {
      const doc = await get(url);
      if (doc.status !== 200) { console.log(`  ${file}: HTTP ${doc.status}`); continue; }
      const text = strip(doc.text);
      // Exhibit sizes vary enormously; keep a bounded window that still spans the operative clauses.
      const body = text.length > 60000 ? `${text.slice(0, 60000)}\n\n[TRUNCATED at 60000 characters of ${text.length}]` : text;
      const name = `${String(++n).padStart(2, '0')}-${q.includes('lease') ? 'lease' : 'credit'}.txt`;
      writeFileSync(join(LEGAL, name), body);
      manifest.push({ kind: 'legal', name, url, cik, accession, source_bytes: doc.buf.length, chars_kept: body.length, chars_total: text.length, sha256: createHash('sha256').update(body).digest('hex'), provenance: 'public — SEC EDGAR' });
      console.log(`  legal ${name}  ${doc.buf.length} bytes -> ${body.length} chars  ${url.slice(0, 90)}`);
      taken += 1;
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      console.log(`  ${file}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- medical: public payer policy
const policyUrl = 'https://www.aetna.com/cpb/medical/data/1_99/0004.html';
try {
  const p = await get(policyUrl);
  if (p.status === 200) {
    const text = strip(p.text);
    const body = text.length > 30000 ? text.slice(0, 30000) : text;
    writeFileSync(join(MED, 'policy-0004.txt'), body);
    manifest.push({ kind: 'medical', name: 'policy-0004.txt', url: policyUrl, source_bytes: p.buf.length, chars_kept: body.length, provenance: 'public — payer medical policy page, no PHI' });
    console.log(`  medical policy-0004.txt  ${body.length} chars`);
  } else console.log(`  policy HTTP ${p.status}`);
} catch (e) { console.log(`  policy: ${e.message}`); }

writeFileSync(join('extract-test/docs', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest: extract-test/docs/manifest.json (${manifest.length} documents)`);
