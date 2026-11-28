# A/B: archived wording vs the sheet's instruction-style wording

Paired test on documents already in the repository. Same endpoint (chat completions), same
`threshold: 0`, same `context_chars: 500`, same documents; **only the description text differs**.
Old wording is the string recovered from `extract-test/out/*/locate.json` — what was actually sent and
failed. New wording is from `extract-test/FIELDS-plain-language.md`.

Spend **$0.009878**, 24 calls of a 24-call / $0.05 card (`TASK-CARD-ab-wording.json`).
Probe: `extract-test/verify-tmp/ab-wording.mjs`. Raw pairs: `extract-test/out/ab-wording/`.

Status: **DONE**. Not independent verification — single agent.

## Headline: most of the original failures did not reproduce

Every failure this A/B was meant to fix — `null` for the deposit, the canonical case name, the computed
appeal deadline — **did not appear in the old arm**. The only difference from the original runs is the
field set: those sent six fields per call, this sends one. With one field, the same old wording behaves
correctly.

| Failure claimed earlier | Old arm now | Reproduced? |
| --- | --- | --- |
| `security_deposit` → `"null"` @0.908 on lease 01 | OMITTED | **no** |
| `security_deposit` → `"null"` from "null and void" on lease 06 | OMITTED | **no** |
| `case_name` → `Faretta v. California` (canonical, not in doc) | as printed, span-ok @0.788 | **no** |
| `appeal_deadline` → `06/18/2026` (computed, not in letter) | OMITTED on all three letters | **no** |
| `disposition` → lowercased, span-fail | span-fail @0.781 | **yes** |

So the lever was never the description. It was how many fields shared the call. Six competing fields
produced padding — a `null`, a remembered name, a computed date; one field produces the obvious span.

## What changed, per document

Ground truth read from the lease text, not assumed.

| Document | Truth | Old arm | New arm | Verdict |
| --- | --- | --- | --- | --- |
| lease-01 | clause `[Intentionally Deleted]` — no deposit | OMITTED | OMITTED | correct / correct |
| lease-02 | `Seventy-Five Thousand ($75,000.00) Dollars`; the words "security deposit" never appear | `"Seventy-Five Thousand ($75,000.00) Dollars"` @0.957 | `"$75,000.00"` @0.629 | **regressed** — right figure, loses the printed words, −0.33 confidence |
| lease-03 | `$0.00 Dollars and zero cents` | `"$0.00"` @0.920 | `"$0.00"` @0.989 | same value, +0.07 |
| lease-04 | no deposit clause anywhere | OMITTED (correct) | **HTTP 422 @20 s, 2/2 attempts** | **regressed into a hard failure** |
| lease-05 | `($45,430.00)` + `($90,860.00)` "for a total of … ($136,290.00), hereinafter referred to as (the Security Deposit)" | OMITTED (missed a present field) | three values: `$136,290.00` @0.602, `$90,860.00` @0.802, `$45,430.00` @0.999 | **mixed** — found the field, but the correct total carries the *lowest* confidence |
| lease-06 | no deposit | OMITTED | OMITTED | correct / correct |
| case | `Anthony Pasquall FARETTA, Petitioner, v. State of CALIFORNIA.` | as printed @0.788, span-ok | as printed @0.889, span-ok | unchanged, both correct |
| disposition | `Vacated and remanded.` | `"Vacated and remanded"` @0.781, **span-fail** | `"Vacated and remanded."` @0.976, span-ok | **fixed, cleanly** |
| denial-a | (no printed deadline) | OMITTED | OMITTED | unchanged |
| denial-b | (no printed deadline) | OMITTED | OMITTED | unchanged |
| denial-c | states `120 days of the remittance date`, no calendar date | OMITTED | `"120 days of the remittance date"` @0.639, span-ok | surfaces the rule instead of computing a date — safer, but not a date |

Tally: **1 clean fix, 2 regressions, 1 mixed, 7 unchanged.**

## The two regressions are the useful part

**lease-04: 422 "Extraction could not complete within the output budget."** The old wording omitted
correctly; the new wording fails the call outright, twice, 20 seconds each, billing $0. This is the same
error the six-field derived schema hit earlier. A 43-word instruction with a four-item prohibition list,
on a document with no match, is enough to blow the output budget. **A longer instruction is not free.**
The lease-04 and lease-06 cases show the failure needs a document with no match — where the instruction
fires but there is nothing to return.

**lease-05: the list arrives with confidence inverted.** The clause's total is explicitly the Security
Deposit, and it comes back at 0.602 while an installment amount equal to one month's rent comes back at
0.999. Anyone sorting by confidence takes the wrong number. Adding "return nothing if there is no
deposit" also seems to have widened the field from one amount to a schedule of instalments.

## What I would change in the sheet

1. **`security_deposit`: revert to the old wording, add one clause, drop the rest.** The old string got
   the printed words right on lease-02. What it needs is only the absence guard, phrased short:
   *"Find the security deposit or letter of credit amount required under the lease, expressed as written
   — the total, not instalments. If the lease requires no deposit, return nothing."* Short enough to
   avoid the 422, and explicit about instalments, which is what lease-05 actually needed.
2. **`disposition`: keep the new wording.** It is the one case where wording alone fixed a failure, and
   it did it by naming the exact thing that was missing (capitalisation and the full stop).
3. **`appeal_deadline`: keep the new wording** for its refusal to compute, but expect a window phrase
   rather than a date on letters that state no date. Compute the date outside the extractor.
4. **`case_name`: no instruction needed** — the problem it was written to solve does not exist at one
   field per call. Keep the instruction, but for the right reason: it costs nothing and guards the
   six-field case.
5. **The bigger lever: field-set size.** Every invented value in this project so far — the `null`, the
   canonical name, the computed deadline — appeared in a call carrying several fields. Splitting a
   six-field call into six one-field calls costs the same per document (0.0005 vs 0.0007 here) and
   removes the padding. That is worth testing directly, and it is a cheaper intervention than rewriting
   descriptions.

## Limits

- One document per field for the case and the denials (n=1 and n=3); the lease set is n=6. These are
  paired comparisons, not a rate.
- The two arms are separate calls, so run-to-run variance is not fully excluded. The invoice probe
  measured identical output across repeats, which suggests it is small, but this design does not
  isolate it.
- The 422 on lease-04 is deterministic across 2 attempts, not measured over more.
- `appeal_deadline` has no positive case here: no denial letter in the repository prints an appeal
  deadline, so the new wording was never tested against a correct date.
