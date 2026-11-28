// Corrected variant of the operator's pasted extract.ts, run against the Extractions API.
//
//   npx tsx extract-test/verify-tmp/extract-alpha.ts document.txt [--size 3000] [--overlap 300]
//        [--fields "name:instruction|name:instruction"] [--out path.json]
//
// Only three behaviours differ from the paste. Each is a measured defect, not a preference:
//
//  1. A missing `span` no longer sends the value to review. The route's docs say ScaleDown omits
//     `span` when its offsets do not delimit the returned text (an entity crossing a line break,
//     returned with whitespace normalised), so the paste discarded real answers: 1, 7 and 9 per run
//     across three measured configurations. Such a value is now re-located in the chunk body
//     (exact first, then whitespace/case canonicalised) and only reviewed if it is not there.
//  2. `span` is validated as nullable. The paste's `z.tuple(...).optional()` rejects a literal
//     `span: null`, and because `Response.parse` runs on the whole body, one null span lost the
//     entire document, not just that answer.
//  3. Repeated values for one field are resolved by an explicit, printed rule instead of an
//     arbitrary Map insertion order: most independent observations first, then the earliest
//     code-point offset (the first mention is the defining one), with every loser kept in
//     `alternatives` and `needs_review` set. On lease 01 `commencement_date` returned both
//     "noon on the commencement date specified in Exhibit A" @4401 and "first day of August, 1995"
//     @8426; silently keeping whichever arrived first was not a decision.
import { readFile } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};

const DEFAULT_FIELDS = {
  invoice_number: {
    type: 'text',
    instructions: 'Find the invoice number or reference.',
  },
  effective_date: {
    type: 'text',
    instructions: 'Find the execution or effective date in the text.',
  },
} as const;

type FieldSpec = { type: 'text'; instructions: string };

function parseFields(spec: string | undefined): Record<string, FieldSpec> {
  if (!spec) return { ...DEFAULT_FIELDS };
  const out: Record<string, FieldSpec> = {};
  for (const part of spec.split('|')) {
    const at = part.indexOf(':');
    if (at < 0) throw new Error(`Field spec needs "name: instruction", got "${part}"`);
    out[part.slice(0, at).trim()] = { type: 'text', instructions: part.slice(at + 1).trim() };
  }
  return out;
}

const SIZE = Number(flag('size', '3000'));
const OVERLAP = Number(flag('overlap', '300'));
const OUT = flag('out', '');
const fields = parseFields(flag('fields', ''));

const Answer = z.object({
  type: z.literal('text'),
  value: z.string().nullable(),
  // Fix 2: a null span is legal on this route and must not abort the document.
  span: z.tuple([z.number().int(), z.number().int()]).nullable().optional(),
  confidence: z.number().optional(),
});

const Response = z.object({
  answers: z.record(z.string(), Answer),
  truncated: z.boolean(),
  usage: z.object({ cost: z.number().optional() }).passthrough().optional(),
});

type Match = {
  field: string;
  text: string;
  // Global [start, end) offsets in Unicode code points.
  start: number;
  end: number;
  confidence?: number;
  context: string;
  boundary: boolean;
  votes: number;
  locatedBy: 'span' | 'relocated-in-body' | 'relocated-in-body-canonicalised' | 'relocated-in-body-punctuation-insensitive';
};

type Review = {
  field: string;
  text: string;
  chunkStart: number;
  reason: string;
};

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Whitespace-collapsed, lower-cased view of a code-point array, with a map back to its indices. */
function normalised(points: string[]) {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < points.length; i++) {
    const c = points[i]!;
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

type Located = { at: number; end: number; how: 'relocated-in-body' | 'relocated-in-body-canonicalised' | 'relocated-in-body-punctuation-insensitive' };

/**
 * Fix 1: an answer without a usable span is looked for in the chunk instead of being discarded.
 *
 * Three passes, each one measured against a real answer on lease 05:
 *  - exact, because most span-less values are verbatim;
 *  - whitespace/case collapsed, because the route normalises whitespace in returned values;
 *  - punctuation stripped, because the lease writes `($136,290.00)` and the route returns
 *    `136290.00`. Without this pass the security deposit was located correctly by the model, in the
 *    right window, and still landed in review as ungrounded.
 */
function locateInChunk(chunk: string[], value: string): Located | null {
  const needle = Array.from(value);
  for (let i = 0; i + needle.length <= chunk.length; i++) {
    if (chunk[i] === needle[0] && chunk.slice(i, i + needle.length).join('') === value) {
      return { at: i, end: i + needle.length, how: 'relocated-in-body' };
    }
  }

  const target = collapse(value);
  if (!target) return null;

  const n = normalised(chunk);
  const at = n.norm.indexOf(target);
  if (at !== -1) {
    return { at: n.map[at]!, end: n.map[at + target.length - 1]! + 1, how: 'relocated-in-body-canonicalised' };
  }

  // Alphanumeric-only view: strip punctuation and whitespace on both sides and compare.
  let flat = '';
  const flatMap: number[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i]!;
    if (/[a-z0-9]/i.test(c)) {
      flat += c.toLowerCase();
      flatMap.push(i);
    }
  }
  const flatTarget = target.replace(/[^a-z0-9]/g, '');
  if (!flatTarget) return null;
  const flatAt = flat.indexOf(flatTarget);
  if (flatAt === -1) return null;
  return {
    at: flatMap[flatAt]!,
    end: flatMap[flatAt + flatTarget.length - 1]! + 1,
    how: 'relocated-in-body-punctuation-insensitive',
  };
}

async function extractChunk(text: string) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Set OPENROUTER_API_KEY');

  const response = await fetch('https://openrouter.ai/api/alpha/extractions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'scaledown/extract',
      state: text,
      fields,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Extraction failed (${response.status}): ${await response.text()}`);
  }

  const result = Response.parse(await response.json());
  if (result.truncated) throw new Error('Chunk was truncated; reduce chunk size');
  return { answers: result.answers, cost: result.usage?.cost ?? 0 };
}

async function extractDocument(document: string, size = 3000, overlap = 300) {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) ||
      size <= 0 || overlap < 0 || overlap >= size) {
    throw new Error('Require integer size > overlap >= 0');
  }

  const points = Array.from(document);
  const matches = new Map<string, Match>();
  const review: Review[] = [];
  let calls = 0;
  let cost = 0;
  let spanAbsent = 0;
  let relocated = 0;

  for (let chunkStart = 0; chunkStart < points.length; chunkStart += size - overlap) {
    const chunkEnd = Math.min(chunkStart + size, points.length);
    const chunk = points.slice(chunkStart, chunkEnd);
    const { answers, cost: chunkCost } = await extractChunk(chunk.join(''));
    calls++;
    cost += chunkCost;

    for (const [field, answer] of Object.entries(answers)) {
      if (answer.value === null) continue;
      const value = answer.value;
      const span = answer.span; // undefined or null both mean "no span"

      let local: { at: number; how: Match['locatedBy'] } | null = null;
      let missReason = '';

      if (span) {
        const [start, end] = span;
        if (start < 0 || end <= start || end > chunk.length) {
          missReason = 'span out of range for the chunk';
        } else if (chunk.slice(start, end).join('') !== value) {
          missReason = 'span does not delimit the returned value';
        } else {
          local = { at: start, how: 'span' };
        }
      } else {
        spanAbsent++;
        missReason = 'answer carried no span';
      }

      let localEnd = 0;
      if (!local) {
        const found = locateInChunk(chunk, value);
        if (found) {
          local = { at: found.at, how: found.how };
          localEnd = found.end;
          relocated++;
        } else {
          review.push({
            field,
            text: value,
            chunkStart,
            reason: `${missReason}; value does not occur in the chunk body`,
          });
          continue;
        }
      }

      const start = chunkStart + local.at;
      const end = localEnd ? chunkStart + localEnd : start + Array.from(value).length;
      const localSpanEnd = end - chunkStart;
      const boundary =
        (local.at === 0 && chunkStart > 0) ||
        (localSpanEnd === chunk.length && chunkEnd < points.length);

      // Dedup on the resolved global coordinates, so one value seen in overlapping windows merges.
      const key = `${field}|${start}|${end}|${value}`;
      const previous = matches.get(key);
      if (previous) {
        previous.votes++;
        if (previous.boundary && !boundary) previous.boundary = false;
        continue;
      }

      matches.set(key, {
        field,
        text: value,
        start,
        end,
        confidence: answer.confidence,
        context: points.slice(Math.max(0, start - 500), Math.min(points.length, end + 500)).join(''),
        boundary,
        votes: 1,
        locatedBy: local.how,
      });
    }

    if (chunkEnd === points.length) break;
  }

  // Fix 3: one printed rule decides between repeated values; nothing is dropped.
  const TIEBREAK = 'votes desc, then non-boundary over boundary, then earliest code-point offset';
  const byField = new Map<string, Match[]>();
  for (const match of matches.values()) {
    const list = byField.get(match.field) ?? [];
    list.push(match);
    byField.set(match.field, list);
  }

  const resolved: Record<string, unknown> = {};
  for (const field of Object.keys(fields)) {
    const candidates = (byField.get(field) ?? []).sort(
      (a, b) =>
        b.votes - a.votes ||
        Number(a.boundary) - Number(b.boundary) ||
        a.start - b.start,
    );
    const [best, ...rest] = candidates;
    if (!best) {
      resolved[field] = { status: 'absent' };
      continue;
    }
    resolved[field] = {
      status: rest.length ? 'conflict' : 'ok',
      needs_review: rest.length > 0,
      text: best.text,
      start: best.start,
      end: best.end,
      votes: best.votes,
      confidence: best.confidence ?? null,
      located_by: best.locatedBy,
      alternatives: rest.map((c) => ({
        text: c.text,
        start: c.start,
        end: c.end,
        votes: c.votes,
        located_by: c.locatedBy,
      })),
      tiebreak: rest.length ? TIEBREAK : null,
    };
  }

  return {
    matches: [...matches.values()],
    review,
    resolved,
    usage: {
      calls,
      cost_usd: Number(cost.toFixed(8)),
      span_absent: spanAbsent,
      relocated_from_body: relocated,
    },
  };
}

async function main() {
  const path = argv[0];
  if (!path) throw new Error('Usage: npx tsx extract-alpha.ts document.txt [--fields "a:...|b:..."]');
  const document = await readFile(path, 'utf8');
  const result = await extractDocument(document, SIZE, OVERLAP);
  const text = JSON.stringify({ doc: path, size: SIZE, overlap: OVERLAP, fields: Object.keys(fields), ...result }, null, 2);
  if (OUT) {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, text);
  }
  console.log(text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
