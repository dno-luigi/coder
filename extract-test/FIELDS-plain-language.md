# Field asks, written in plain language

Practice sheet for `scaledown/extract`, written against the guidance in `Extract/extract.md` and
`Extract/docs.md`. **Nothing here was run.** No model calls, no spend. This is the writing half.

The rules I am writing to, quoted from the docs:

- "Descriptions can be instructions. Write `"Find the first and last name of the person in the text"` rather
  than just `"Name"`. Full instructions consistently outperform short noun phrases."
- "Use lowercase or Title Case labels. The model was trained with lowercase entity names."
- "Be specific, and test synonyms."
- "Don't mix overlapping granularities." Pick `location` or `city`, not both.
- "The wording matters." `"With currency"` on amounts makes the value carry the code or symbol.
- Categorical fields (`enum` / `oneOf`) go to the classifier, not the span extractor.

"Text" means one value comes back. "List" means the field is asked as a list and may return several.

---

## Lease / amendment

| Field | The ask, in plain language | Returns |
| --- | --- | --- |
| `landlord` | Find the company or person named as the landlord or lessor. Return the name exactly as printed, including the entity suffix such as LLC, Inc or LP. | text |
| `tenant` | Find the company or person named as the tenant or lessee. Return the name exactly as printed, including the entity suffix. | text |
| `premises` | Find the address or written description of the space being leased, quoted as printed. | text |
| `monthly_rent` | Find the amount of base rent the tenant pays each month, exactly as printed, with its currency symbol or code. Do not convert it to an annual figure and do not add a total. | text |
| `rent_escalations` | List every rent increase the lease states, one entry per increase, each quoting the new amount with currency and the date it takes effect. | list |
| `abatement` | Find the period during which rent is waived or abated, with its start and end dates quoted as printed. If rent is not abated anywhere in the document, return nothing. | text |
| `term_end` | Find the calendar date on which the lease term ends, as printed. If the document only states a term length and a start date, return nothing rather than calculating the end date. | text |
| `notice_days` | Find how many days' notice the tenant must give to terminate or not renew, stated as a number of days quoted from the clause. | text |
| `security_deposit` | Find the amount held as a security deposit or letter of credit, exactly as printed with currency. If the lease requires no deposit, return nothing — do not return the words null, none, N/A, or the phrase null and void. | text |
| `governing_law` | Find the state or jurisdiction whose law governs the lease, as printed in the governing-law clause. | text |
| `renewal_options` | List each renewal or extension option, one entry per option, quoting the sentence that grants it and any notice requirement it states. | list |
| `permitted_use` | Quote the clause describing what the premises may be used for. | text |

Why these are worded this way: `security_deposit` carries an explicit refusal because a real lease
returned the word `null` — taken from the clause "shall be null and void" — at 0.787 confidence.
`term_end` refuses to calculate because a lease came back one day long: 1 April 2034 where the term
ended 31 March 2034. `monthly_rent` says "do not convert" because the field is a monthly amount and the
document also prints an annual one.

---

## Judicial opinion

| Field | The ask, in plain language | Returns |
| --- | --- | --- |
| `case_name` | Quote the case name exactly as this document prints it, including the parties' full names and the words Petitioner and Respondent. Do not substitute the well-known short name of the case. | text |
| `citation` | Find the United States Reports citation for this case, in the form 422 U.S. 806. | text |
| `court` | Find the name of the court that decided the case, as printed. | text |
| `decision_date` | Find the date the court decided the case, as printed. Do not return the date it was argued or the date of an earlier opinion it cites. | text |
| `authoring_justice` | Find the name of the justice who delivered the opinion of the Court, including the honorific Mr. Justice or Ms. Justice, as printed. | text |
| `disposition` | Quote the sentence that states what the court did with the judgment below, for example "Vacated and remanded." Return the sentence as printed, including its capitalisation and full stop. | text |
| `dissenting_justices` | List the name of every justice who joined a dissenting opinion, one entry per justice, quoted from the line that begins their dissent. | list |
| `holding` | Quote the sentence in the syllabus or opening paragraph that states what the Court holds. | text |

`case_name` is the one to watch: asked plainly for "the name of the case", the model returned
`Faretta v. California` — the canonical name it knows — while the document prints `Anthony Pasquall
FARETTA, Petitioner, v. State of CALIFORNIA.` The instruction to quote the document is doing real work
there. `disposition` says "including capitalisation" because the document's `Vacated and remanded.` came
back lowercased and failed its span check on that alone.

---

## Denial letter / EOB

| Field | The ask, in plain language | Returns |
| --- | --- | --- |
| `payer` | Find the name of the insurance company or plan that issued this denial, as printed. | text |
| `claim_id` | Find the claim number or claim identifier this denial refers to, exactly as printed. | text |
| `date_of_service` | Find the date or date range of the service that was denied, as printed. | text |
| `carc_codes` | List every Claim Adjustment Reason Code in the letter, one entry per code, as printed with its short description if one is given. | list |
| `rarc_codes` | List every Remittance Advice Remark Code in the letter, one entry per code, as printed. | list |
| `billed_amount` | Find the amount billed by the provider, exactly as printed, with currency. | text |
| `allowed_amount` | Find the amount the plan allowed, exactly as printed, with currency. If the letter states no allowed amount, return nothing rather than reusing the billed or paid amount. | text |
| `paid_amount` | Find the amount the plan paid, exactly as printed, with currency. | text |
| `denial_reason` | Quote the sentence that states why the claim was denied. | text |
| `appeal_deadline` | Find the date by which an appeal must be filed, as printed in the letter. Return only a date that appears in the document; do not calculate one from a number of days. | text |
| `appeal_address` | Find the mailing address or fax number to which an appeal must be sent, quoted as printed. | text |

`appeal_deadline` refuses to calculate because the model happily computes one: on a denial it returned
`06/18/2026` — 60 days after the service date, arithmetically right, and nowhere in the letter. A field
that computes is a field that cannot be cited.

---

## Prior-authorization policy

| Field | The ask, in plain language | Returns |
| --- | --- | --- |
| `policy_number` | Find the policy or coverage-determination number, as printed. | text |
| `policy_title` | Quote the title of the policy, as printed. | text |
| `criteria` | List each coverage criterion the policy states, one entry per criterion, quoted in full including any letter or number label the policy gives it. | list |
| `required_documents` | List the documents or records the policy requires to be submitted with a request, one entry per item. | list |
| `frequency_limit` | Find any limit the policy places on how often the service may be repeated, quoted as printed. | text |

The criteria list is deliberately one entry per criterion rather than one blob: the decision layer reads
them individually, and a criterion that arrives merged with its neighbour cannot be scored separately.

---

## Invoice

Wording taken from `Extract/docs.md`, which is already good and worth copying as-is:

| Field | The ask, in plain language | Returns |
| --- | --- | --- |
| `vendor` | Name of the company issuing the invoice | text |
| `invoice_number` | Invoice number or reference | text |
| `subtotal` | Subtotal before tax, with currency | text |
| `vat` | VAT or sales tax amount, with currency | text |
| `total` | Total amount due including tax, with currency | text |
| `due_date` | Payment due date | text |

The only addition I would make is on `due_date`: "Payment due date, exactly as printed. Do not convert
it to another format." The page's own note says dates come back as printed — `20 Oct 2026`,
`31.10.2026` — so asking for a format is asking for a value that will not match its span.

---

## Before and after

The practice, in five pairs. Left is what I wrote in the first draft of these sheets; right is after
applying "descriptions can be instructions".

| Before | After |
| --- | --- |
| `"Security deposit"` | Find the amount held as a security deposit or letter of credit, exactly as printed with currency. If the lease requires no deposit, return nothing. |
| `"Date"` | Find the date the court decided the case, as printed. Do not return the date it was argued. |
| `"Parties"` | Find the company or person named as the landlord. Return the name exactly as printed, including the entity suffix. |
| `"Amounts"` | Find the amount billed by the provider, exactly as printed, with currency. |
| `"Case name"` | Quote the case name exactly as this document prints it. Do not substitute the well-known short name. |

Two of those rewrites exist because the short version measurably failed: `"Security deposit"` returned
`null`, and `"Case name"` returned a name that is not in the document.

## What I would not ask for

- **A computed value in a cited field.** "The end date of the lease" invites arithmetic; the answer has
  no span. Ask for the printed term and let the reconcile step compute.
- **Two granularities at once.** `location` and `city` in the same call split the results unpredictably,
  per the docs. One level per concept.
- **A yes/no as an entity.** "Is rent abated?" has no span. That is a classification key with a rubric
  (`met` / `not_met` / `insufficient_evidence`), not an extraction field.
- **A format the document does not print.** Asking for ISO dates in a document that prints
  `20 Oct 2026` produces a value that cannot be cited back to its source.
