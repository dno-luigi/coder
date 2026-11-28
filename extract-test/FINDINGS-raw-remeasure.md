# The harness removed: one field per call, re-measured

Operator's instruction: the harness was distorting things; start from the bare API. So the same seven
documents, the same archived descriptions, sent one field per call — nothing between the document and
the response except a span check.

42 calls, **$0.024523**. Card: `TASK-CARD-raw-remeasure.json`. Probe: `verify-tmp/raw-remeasure.mjs`.
Archive: `out/raw-remeasure/`.

Scoring is deliberately mechanical, and applied identically to the archived harness run:

- **grounded** — the value appears in its own document, case- and whitespace-insensitive
- **span exact** — `doc.slice(start,end) === text`
- **span shifted** — offsets point at a real window that is not the value
- **span empty** — offsets produce nothing

## Result

| Arm | values | span exact | span shifted | span empty | grounded | **not in document** |
| --- | --- | --- | --- | --- | --- | --- |
| harness, 6 fields/call | 40 | 25 (62%) | 15 | 0 | 37 | **3** |
| raw, 1 field/call | 35 | 19 (54%) | 10 | 6 | 35 | **0** |

Recall by field:

| Document | harness found | raw found |
| --- | --- | --- |
| lease-01 | 6/6 | **1/6** |
| lease-02 | 5/6 | 4/6 |
| lease-03 | 6/6 | 6/6 |
| lease-04 | 5/6 | 4/6 |
| lease-05 | 6/6 | 4/6 (base_rent returned 7 values) |
| lease-06 | 6/6 | 4/6 |
| Faretta | 6/6 | 6/6 |
| **total** | **40/42** | **29/42** |

## The three invented values were all the harness's

| Arm | Document | Field | Value | Confidence |
| --- | --- | --- | --- | --- |
| harness | lease-01 | `security_deposit` | `null` | 0.908 |
| harness | lease-01 | `commencement_date` | `August 1, 1995` | 0.444 |
| harness | Faretta | `case_name` | `Faretta v. California` | 0.713 |

Not one value from a single-field call was absent from its document. On the axis the operator was
pointing at — invented values — removing the harness removes them completely. `lease-01`'s deposit
clause is `[Intentionally Deleted]`, so `null` was invented outright; the Faretta case name is not in
the document; and `August 1, 1995` does not appear in lease-01 at all.

## But the harness was also doing the recall work

`lease-01` found 1 of 6 fields at one per call and 6 of 6 at six per call. The five misses are not
absent from the document: `Landlord` is at char 318, `Tenant` at 505, the term at 4413, the premises at
1540. They are real fields the single-field calls never fired on.

This is the zero-entity cliff the brief described, and it is worse than the brief implies: an abstract
description (`"the entity taking the lease"`) against a 60,000-character document returns nothing, while
the same description among six siblings returns four of six. **The multi-field call is the recall
mechanism.** Removing it trades three invented values for eleven missing ones.

## The larger finding: the offsets were never reliable

This is what the re-measurement made unavoidable. Even in the harness arm, **15 of 40 spans point at
the wrong window** — the value is right, the offsets are shifted, occasionally by a character and
occasionally across a line break. In the raw arm 16 of 35 are unusable (10 shifted, 6 empty).

Examples: returned `399 EXTERIOR STREET ASSOCIATES LLC`, span
`99\nEXTERIOR STREET ASSOCIATES LLC, as Le`; returned `January 1, 2008` for the document's
`the 1st day of January, 2008` with a span starting mid-word; returned seven printed rent figures for
lease-05, six of them with an empty span.

So `citation_verbatim` — the metric this project has been quoting since the first harness run — was
measuring offset arithmetic, not grounding, and it was failing on 38% of values while the reports said
98%. The normalised-containment figure that looked like a concession was in fact the valid measure.

Practical consequence: offsets are anchors to re-locate from, never spans to highlight. Re-find the text
in the document and use the found position. That is a two-line change and it retires the whole
`citation_verbatim` column.

## What the data actually supports

Neither mode alone. Both arms measured, same documents:

| Strategy | Grounded values | Fields found |
| --- | --- | --- |
| harness only | 37 | 40/42 |
| raw only | 35 | 29/42 |
| **harness + free grounding gate** | **37** (drop 3) | **40/42** |

The gate costs nothing: containment is a string search. It removes exactly the three values that were
invented and keeps the recall the batching buys. The raw arm cannot be rescued the same way — its
missing fields never come back.

So: **batch for recall, gate on grounding, re-locate the text for the citation.** The harness was wrong
in two ways — it manufactured values, and it measured its own offsets — but the fix is a gate and a
re-locate, not deletion.

## Limits

- One run per cell. No repeats, so per-cell variance is unmeasured; the earlier invoice probe found
  byte-identical repeats, which suggests it is small but does not establish it here.
- Seven documents. The recall difference is concentrated in `lease-01`, which is one document.
- `base_rent` on lease-05 returns a seven-value rent schedule: correct figures, but a list where the
  field asked for one amount. Value counts and field counts therefore differ between arms.
- Grounding is a string test. A grounded value can still be the wrong field, and a value can be right
  while worded differently (`January 1, 2008` for `the 1st day of January, 2008` fails a naive
  containment check — this pass is case- and whitespace-insensitive, not format-insensitive).
