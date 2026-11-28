# Card back — independent test of both verticals

To Agent 1, from Agent 2. Base commit `7dd53360088acb9b1a49786244ef1f593287fb16` (tree `99912ff5`),
measured, not inherited. **Spend: $0.004763, 28 calls**, against the $0.10 / 120-call allowance.
Nothing was committed, pushed, published or deployed. No PHI was sent, generated or received.

Machine-readable returns: `extract-test/card-back-legal.json`, `extract-test/card-back-medical.json`.

## What I ran

| Layer | Calls | Result |
| --- | --- | --- |
| Locate (`scaledown/extract`, `provider.options` shape) | 12 | 65/69 fields found, 65 values, 50 exact-verbatim, 62 normalised-verbatim, 0 zero-entity |
| Decide (`classify-1` via `/alpha/decisions`) | 12 | 36 decisions across 12 documents, 3-label rubrics |
| Reconcile (code) | 0 | denial arithmetic matched the stated amount on 3/3 |

Corpus: 6 real property leases from SEC EDGAR (public, 14k–60k characters), 3 synthetic denial
letters, 3 synthetic clinical notes modelled on the real Aetna CPO 0004 policy. Rejections during
acquisition are logged in `extract-test/docs/legal-rejections.json`.

## The three things worth your attention

**1. Your verbatim claim is a metric problem, not a model problem.** 24/24 does not reproduce — I got
21/34 exact on real leases. But 32/34 reproduce after collapsing whitespace and punctuation. The
citation check must normalise before it judges, or it discards correct values and reports a model
failure that is a formatting difference. One genuine mangling: `£160,000` came back as
`(pound)160,000` on the UK lease.

**2. The model returns the literal string `null` as a value, above your gate.** Twice, at 0.908 and
0.787. It means "no deposit stated", but a packet that prints it ships `Security Deposit: null`. Your
`confidently_wrong` metric counts these; a one-line client filter removes them. Neither the model nor
the gate will.

**3. My `confidently_wrong` count was wrong, and it flattered the model.** All three hits dissolve on
inspection. The denial rubric asked "is the window open *as at the letter date*" — the model answered
that correctly every time; the gold I wrote answered "is it open today", which I never asked. The
prior-auth hit was the same error: nasal steroid spray for six weeks is conservative treatment, so
`met` at 0.983 is defensible and my label was wrong. The useful version of the metric is: it measures
the rubric author before it measures the model. For a deadline product, the question you actually
need answered — is the window open *now* — was never asked, and the state never contained today's
date.

## Data handling — the blocker, answered in writing

**ScaleDown (model provider).** Zero retention as a stated property: prompts are tokenised in memory,
processed and discarded, never written to disk, "in any environment, including on failure". No
training on customer inputs, architecturally separated pipelines, no opt-out because there is no
opt-in. Content-free operational telemetry retained (latency, token counts, error codes), with one
third-party summary of their DPA reporting content-free logs up to 90 days. HIPAA, GDPR and SOC 2 are
**"in progress"**, which is not a BAA. US-only processing, with written consent required otherwise.
Self-hosted, VPC and air-gapped deployment is offered on enterprise terms.

**OpenRouter (router).** ZDR can be enforced per request (`zdr: true`, `data_collection: "deny"`) or
via guardrails, and it binds routing to ZDR-eligible endpoints. It does not cover the router's own
retention when prompt logging is enabled, and what OpenRouter publishes is a DPA, not a BAA.

**The consequence, stated plainly:** there are two parties in the path and neither publishes a BAA.
A BAA from the model provider would not cover the router, and PHI passes through both. Under the
current architecture neither vertical can lawfully process PHI in the US. Privileged England & Wales
material has a second problem — US-only processing by default — which is a cross-border transfer
question, not only a retention one. The only configuration the provider's own documentation supports
for either data class is self-hosted in the customer's VPC, which is an enterprise deployment, not a
SaaS one.

## Failure modes

| # | Mode | Outcome |
| --- | --- | --- |
| 1 | Zero-entity cliff | **Not reproduced.** 0 zero-entity responses in 12 locate calls. My field wording was concrete rather than role-abstract, which is the variable your own note identifies. |
| 2 | State starvation | **Mitigated, not tested at your scale.** Header plus equal per-value windows, no whole-document truncation; largest document was 60k characters against a 28k window cap. |
| 3 | Absence read as negation | **Reproduced** on the decision layer: absent insurance figure answered `no` at 0.420 with `insufficient_evidence` at 0.350 behind it. The 0.6 gate catches it; the argmax is wrong before the gate. |
| 4 | Third-label rubric overlap | **Reproduced** in the same call: three labels did not stop `no` winning on absent evidence. |
| 5 | Scan fragility | **Not run.** No scan available, and the chat endpoint is text-only. |

## Verdicts

- **Legal: GO-WITH-CONDITIONS.** Literal fields are near-solved (34/36 found, 94% normalised
  citations, $0.00069/document, 3–5 s). The 50% escalation is concentrated in the judgement
  questions, which is exactly the paralegal time the product claims to replace — so price the
  literal abstract, and treat the register/obligation layer as the reviewed tier.
- **Medical: NO-GO.** Not on accuracy — the layer held up better than the legal layer did on real
  documents — but on the data path. No BAA, router in the path, and the deadline decision needs
  today's date before it is worth anything.

Evidence: `extract-test/out/{legal,denial,priorauth}/` — one file per call with the exact request
body and raw response, `results.json`, `calls.jsonl`, plus `extract-test/out-shape/` for the API-shape
probes. If my prose and `out/` disagree, `out/` is right.
