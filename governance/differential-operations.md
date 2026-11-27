# Differential Operations

**Status:** Active foundation v1

Every consequential change must satisfy the following procedure.

## 1. Identify states

Record the exact source state and destination state, including repository identity and immutable object IDs when applicable.

## 2. Make minimal authorized changes

Apply only changes within the operator-authorized scope. Reject unlisted paths and prohibited actions. Do not expand scope through inferred need.

## 3. Preserve reversibility and provenance

Retain the source state, patch or delta, candidate identity, authorization, timestamps, and evidence needed to reconstruct the result.

## 4. Separate new from carried-over information

Distinguish information introduced by the change from unchanged, inherited, stale, or previously observed state.

## 5. Preserve uncertainty and expose gaps

Record unknowns, failed checks, limitations, missing evidence, and commands that could not be executed. A passing subset is not evidence of an unknown or unexecuted condition.

## 6. Enable independent reconstruction

The verifier must be able to reconstruct the exact candidate and independently execute the declared acceptance commands.

## Enforcement

The harness rejects changes outside scope, dirty or mismatched verifier states, unverifiable candidates, failed required commands, missing authorization, and missing governance foundations.
