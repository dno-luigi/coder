// VERBATIM copy of the operator's pasted extract.ts. Do not edit: this file exists to measure the
// proposal as written. The corrected variant lives in extract-alpha.ts.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const fields = {
  invoice_number: {
    type: 'text',
    instructions: 'Find the invoice number or reference.',
  },
  effective_date: {
    type: 'text',
    instructions: 'Find the execution or effective date in the text.',
  },
} as const;

const Answer = z.object({
  type: z.literal('text'),
  value: z.string().nullable(),
  span: z.tuple([z.number().int(), z.number().int()]).optional(),
  confidence: z.number().optional(),
});

const Response = z.object({
  answers: z.record(z.string(), Answer),
  truncated: z.boolean(),
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
};

type Review = {
  field: string;
  text: string;
  chunkStart: number;
  reason: string;
};

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
  return result.answers;
}

async function extractDocument(document: string, size = 3000, overlap = 300) {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) ||
      size <= 0 || overlap < 0 || overlap >= size) {
    throw new Error('Require integer size > overlap >= 0');
  }

  const points = Array.from(document);
  const matches = new Map<string, Match>();
  const review: Review[] = [];

  for (let chunkStart = 0; chunkStart < points.length; chunkStart += size - overlap) {
    const chunkEnd = Math.min(chunkStart + size, points.length);
    const chunk = points.slice(chunkStart, chunkEnd);
    const answers = await extractChunk(chunk.join(''));

    for (const [field, answer] of Object.entries(answers)) {
      if (answer.value === null) continue;

      const span = answer.span;
      if (
        !span || span[0] < 0 || span[1] <= span[0] ||
        span[1] > chunk.length ||
        chunk.slice(span[0], span[1]).join('') !== answer.value
      ) {
        review.push({
          field,
          text: answer.value,
          chunkStart,
          reason: 'Missing or mismatched span',
        });
        continue;
      }

      const start = chunkStart + span[0];
      const end = chunkStart + span[1];
      const boundary =
        (span[0] === 0 && chunkStart > 0) ||
        (span[1] === chunk.length && chunkEnd < points.length);

      const match: Match = {
        field,
        text: answer.value,
        start,
        end,
        confidence: answer.confidence,
        context: points.slice(Math.max(0, start - 500), Math.min(points.length, end + 500)).join(''),
        boundary,
      };

      // Exact coordinate deduplication; retain a non-boundary observation if available.
      const key = JSON.stringify([field, start, end, answer.value]);
      const previous = matches.get(key);
      if (!previous || (previous.boundary && !boundary)) matches.set(key, match);
    }

    if (chunkEnd === points.length) break;
  }

  return { matches: [...matches.values()], review };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npx tsx extract.ts document.txt');
  const document = await readFile(path, 'utf8');
  console.log(JSON.stringify(await extractDocument(document), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
