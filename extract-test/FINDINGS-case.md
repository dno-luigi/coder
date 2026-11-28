# Test of the legal theory on a judicial opinion — 422 U.S. 806

Document: *Faretta v. California*, 422 U.S. 806 (1975), text from Cornell LII, 98,690 characters
(the Justia URL supplied is behind Cloudflare and returned HTTP 403; LII served the same opinion).
Cost: **$0.001209** for locate + decide, **$0.000075** for the control. Two documents' worth of
budget is not needed for one case.

## Fields: 6/6 found, 4/6 exact-verbatim

| Field | Returned | Conf | Verbatim | Document says |
| --- | --- | --- | --- | --- |
| `citation` | `422 U.S. 806` | 0.999 | yes | `422 U.S. 806` |
| `court` | `Supreme Court` | 0.949 | yes | `Supreme Court` (page title) |
| `decision_date` | `June 30, 1975` | 0.980 | yes | `Decided June 30, 1975.` |
| `authoring_justice` | `Mr. Justice STEWART` | 0.973 | yes | `Mr. Justice STEWART delivered the opinion of the Court.` |
| `disposition` | `vacated and remanded` | 0.492 | no (case only) | `Vacated and remanded.` |
| `case_name` | `Faretta v. California` | **0.713** | **no — not in the document** | `Anthony Pasquall FARETTA, Petitioner, v. State of CALIFORNIA.` |

## Decisions: 2/3 as scored, 3/3 after fixing the state

| Question | First run | Control |
| --- | --- | --- |
| petitioner got relief | `yes` 0.972 ✓ | — |
| self-representation right recognised | `yes` 0.995 ✓ | — |
| dissent exists | `insufficient_evidence` **0.697** ✗ | **`yes` 0.987** ✓ |

The control changed one thing: the state. The first run sent 3,393 characters built from windows
around the six extracted values. The Burger dissent begins at character 30,537 and the Blackmun
dissent at 46,759, so neither was in the state. The control added two windows (30300–31600,
46600–47900), 6,037 characters total, same rubric, same model: `insufficient_evidence` 0.697 →
`yes` 0.987.

`BURGER` and `dissent` are both absent from the first state. The decision was wrong about the
document and right about what it was shown.

## Three findings

**1. The literal/derived axis is wrong for judicial opinions.** Everything that matters is stated
somewhere in the judgment: the disposition is a sentence, and the holding is in the syllabus. The
model returned the disposition and answered the two syllabus-level questions at 0.972 and 0.995. The
axis that survives is **stated vs computable** — a lease total must be computed, a disposition need
only be found — and on an opinion almost everything is stated.

**2. The real failure axis is cited vs recalled.** `Faretta v. California` is the canonical name of
a famous case. The model produced it at 0.713 confidence, above the gate, and it appears nowhere in
the document, which renders the name as `Anthony Pasquall FARETTA, Petitioner, v. State of
CALIFORNIA.` For a citation-bearing product this is the dangerous direction: the answer is the one a
lawyer wants, the provenance is invented, and the gate passes it. The grounding check caught it; the
confidence gate would not have.

There is a genuine tension underneath: the document's own rendering contains a typo (`Pasquall`).
A strict citation rule rejects the correct name and forces the typo into the packet; a truth rule
admits an uncited answer. A legal packet needs both fields — `as_written` with a citation, and
`canonical` marked as verified elsewhere, never as extracted.

**3. `confidently_wrong` measured the harness again, for the third time today.** As written, the
metric compares the answer to the document. It has to compare the answer to the state actually sent,
because that is what the decision layer saw and that is what ships. Otherwise a starved state looks
like a weak model, and the response is to change models instead of adding two windows.

## Cost and latency

98,690 characters → 0.9 s locate, 0.4 s decide, $0.0012 all-in. Per-case cost at this length is
about a tenth of a cent; the constraint is not price, it is whether the state contains the sentence
the question depends on.
