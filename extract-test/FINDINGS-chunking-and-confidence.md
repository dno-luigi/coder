# Two claims tested: what `confidence` means, and whether to chunk

Source of the claims: a message asserting that the 1M-token window is a capacity limit and not an
accuracy guarantee, that the docs specify no ideal document size or chunking strategy, that missing
fields are omitted, and that `confidence` means "a match was found" rather than "this value is
probably correct", with a link to `/cookbook/evaluate-and-optimize/extract-invoice-fields-with-scaledown`.

Spend: **$0.001122** (5 chunk calls, 98,690-character document). The confidence analysis reuses
71 values already collected in `extract-test/out/` and costs nothing.

## The cited page does not exist

`https://docs.scaledown.ai/cookbook/evaluate-and-optimize/extract-invoice-fields-with-scaledown` → **HTTP 404**,
and the same path with `.md` → **404**. The index at `docs.scaledown.ai/llms.txt` (38 lines) lists
`/cookbooks/` plural, and the closest page is `/cookbooks/documents.md` ("Files & Docs — filings,
contracts, reports and case files"). Its advice is not chunking: it recommends **Compress**
(strip redundant text before the LLM) and **Summarize** (digest a long filing into a brief). So the
documented intervention for long documents is compression, not splitting — which is a different
claim from the one made in the message.

## `confidence` does not distinguish a citation from an assertion

71 extracted values across four verticals, each checked against its source document.

| Confidence band | n | Value appears in the document | Exact verbatim |
| --- | --- | --- | --- |
| 0.0–0.5 | 7 | 86% | — |
| 0.5–0.7 | 14 | 93% | 57% (0.0–0.6) |
| 0.7–0.9 | 11 | 91% | 56% (0.6–0.9) |
| 0.9–1.0 | 39 | 97% | 92% |

Grounding is flat across bands: 86–97% with no monotone trend. Only above 0.9 does exact verbatim
move, and even there 8% still fail it. **57 values cleared a 0.6 gate; 3 of those have no citation in
the document at all:**

| Vertical | Field | Value | Confidence | What it actually is |
| --- | --- | --- | --- | --- |
| legal | `security_deposit` | `"null"` | 0.908 | absence, serialised as a string |
| medical | `appeal_deadline` | `"06/18/2026"` | 0.610 | a **computed** date (60 days from 2026-04-19), correct, no span |
| case | `case_name` | `"Faretta v. California"` | 0.713 | a **recalled** name; the document says `Anthony Pasquall FARETTA, Petitioner, v. State of CALIFORNIA.` |

So the claim is directionally right and understated. `confidence` is not "a match was found": it also
rides on a computed value and on an absence. Operationally it means "the model has something it is
willing to assert", which covers matched, computed, invented and absent. It cannot be used to decide
whether a citation exists — only grounding can.

## Chunking: better citations, new false negatives

Same six fields, same descriptions, same document. Five chunks split at line boundaries (~19.8k
characters each), one call per chunk.

| | Whole document | Five chunks |
| --- | --- | --- |
| Fields found | 6/6 | 6/6 (all in chunk 1) |
| Exact verbatim | **4/6** | **6/6** |
| `case_name` | `Faretta v. California` (canonical, recalled) | **`Anthony Pasquall FARETTA, Petitioner, v. State of CALIFORNIA.`** (as written) |
| `disposition` | `vacated and remanded` (case folded) | **`Vacated and remanded.`** (as written) |
| Cost | $0.001209 | $0.001122 |
| Chunks returning nothing | — | **4 of 5** |

Chunking fixed both citation failures, including the recall substitution — a 19k-character window
leaves the model no room to answer from memory about a case it recognises. It cost the same.

The hazard is the second row: four of five chunks returned zero entities, correctly, because those
fields genuinely appear only in the headnote/syllabus. A pipeline that treats an empty chunk as a
failure would retry four times per document; a pipeline that samples one chunk would report that the
document has no case name. Chunked extraction needs a document-level merge, and "no match in this
chunk" must not be an error.

## What this changes

1. **Chunk for citation fidelity, merge for recall.** Run the whole document when recall matters,
   chunk when the citation must be exact, and reconcile the two. On this document the whole-document
   pass was right about *what* the case is and wrong about *how the document says it*; the chunked
   pass was the reverse on four chunks and correct on the one that mattered.
2. **Split packet lines into `as_written` and `derived`.** The computed deadline and the recalled case
   name are the same defect class: a correct answer with no provenance. A packet that shows them as
   cited is lying about where they came from.
3. **Grounding is the correctness gate; confidence is a routing hint.** A value that fails grounding
   is not a value — it is a claim. Route it to a human or to a computation, never to the packet.
4. **Compress before you chunk.** That is what the provider's own cookbook recommends for long
   documents, and it addresses the token bill; chunking addresses citation fidelity. They are not
   substitutes.
