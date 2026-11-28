# Reproduction of the published invoice recipe, and a correction to my own counterexample

Source page: openrouter.ai/docs, "Extract Invoice Fields with ScaleDown Extract" (supplied by the operator).
Task card: `extract-test/verify-tmp/TASK-CARD-invoice-probe.json`. Probe: `extract-test/verify-tmp/invoice-probe.mjs`.
Spend: **$0.000045** across 3 calls, 384 input tokens each. All three written to `extract-test/out/invoice/`.

Status: **DONE** for the reproduction. **UNVERIFIED** as independent verification — single agent, no
verifier worktree, so nothing here is corroborated by a second executor.

## All four claims held

| Claim | Result |
| --- | --- |
| Documented `start`/`end` offsets index into the invoice | **6/6 correct** — `INVOICE.slice(start,end)` equals `text` for every entity the page lists |
| Responses API accepts `provider.options.scaledown.entities` | **works** — `/api/v1/responses`, `input`, JSON string in `output[].content[].output_text` |
| Same invoice twice returns the same fields | **identical** — same six values *and* the same six confidences across two runs |
| Absent field is omitted | **held** — VAT line removed, 5 entities, no `vat` entity, `total` span correctly re-indexed to [228:240] |

Documented values reproduce exactly. **Documented confidences do not:** the page shows `subtotal 0.999`,
`vat 1`, `due_date 1` (and `0.776` in its other example); this run returned `0.996`, `0.987`, `0.999`.
Same snapshot, different numbers, so the published confidences are not a calibration reference.

The absent-VAT run also shows the model did not invent a tax figure: it dropped the field and left
`subtotal 1,820.00` against `total 2,165.80`, which the recipe's arithmetic check would flag. That is
the behaviour the page promises, observed.

## The cost figure reproduces, and does not generalise

`usage.cost` was **$0.00001536** for a 384-token input → **$0.01536 per 1,000 invoices**, inside the
page's stated "$0.012 to $0.015". Their figure is accurate at invoice scale.

It is not a document-scale figure. A 98,690-character filing cost **$0.001209** per call in the same
session — roughly **$1.20 per 1,000**, about 80× the invoice rate. Anyone carrying that number from the
invoice page to the "Files & Docs" case-file recipe will under-budget by two orders of magnitude.

One free detail: `usage.output_tokens` was 591 against 384 input, and `cost_details` reports
`upstream_inference_output_cost: 0`. Each entity carries a `context` field (for this invoice, the whole
document). Carrying a citation snippet per entity costs nothing; there is no reason to ship a value
without its source text.

## Correction: my `"null"` counterexample was two different failures

I have been citing "`null` returned as a literal value at 0.908 and 0.787" as proof that confidence
attaches to non-matches. Checked against the lease texts, the two rows are not the same event:

| Document | Field | Value | Conf | Document at the span | What happened |
| --- | --- | --- | --- | --- | --- |
| `06-property-lease.txt` | `security_deposit` | `null` | 0.787 | char 50416: `...shall, at the option of Landlord, be **null** and void...` | a **true textual match** of the word "null" in a breach clause |
| `01-property-lease.txt` | `security_deposit` | `null` | 0.908 | the document contains no occurrence of "null" at all | a value that is **not in the document** |

So one is a false token match and the other is an uncited value. The first is the more instructive:
"null" is ordinary contract language — a field about absence matched a word that appears inside a clause
about default. **A valid span proves the text exists, not that it is about the field.** Confidence 0.787
is doing exactly what the page says it does, reporting that a match was found.

Limitation on this correction: the raw API response bodies for the legal locate call were not archived
(only `locate.json` request, `results.json`, and a 699-byte `calls.jsonl`), so I cannot distinguish "the
API returned no span" from "my harness dropped the span". The archive is internally inconsistent for
these rows — row 06 records `verbatim: true` with no `end` offset. The authoritative check is slicing the
document, which is what the table above reports. Earlier statements of mine that treated both rows as
one failure mode were imprecise.

## What this adds to the recipe

1. **The page's confidence advice is right and my measurements are stronger than its wording.** Across
   71 values, grounding was 86% / 93% / 91% / 97% by confidence band — flat. Two above-gate values had
   no source text, in two different ways.
2. **Grounding must be field-relative.** Neither the page nor my earlier rule covers the `null and void`
   case: the span was real. A span check catches `01` and misses `06`. The missing check is semantic —
   is this text an answer to this question — and no confidence number substitutes for it.
3. **Arithmetic triage validates consistency, not provenance.** It catches the missing VAT line (observed)
   and would catch totals that do not add up. It does not catch a due date off by one day (observed on
   real leases: 1 April 2034 for 31 March 2034), a recalled canonical name (`Faretta v. California` for
   the document's own rendering), or a rewritten currency symbol (`£160,000` → `(pound)160,000`, which
   their `parseMoney` rejects — for the wrong reason, as an accounting negative, but at least it stops).
4. **The recipe is sound as a pattern**: extracted values, a span check, an arithmetic check, review for
   the rest. It is a good template. It just needs the span check turned into a relevance check, and the
   cost table labelled per-invoice rather than per-document.
