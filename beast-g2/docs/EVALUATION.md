# Summary quality evaluation

This harness measures the quality of structured session summaries against
hand-annotated synthetic transcripts. It is an evaluation tool, not a summarizer. The
`summary` field in a fixture is a recorded output that replay mode scores; no model is
called during a replay.

## What it measures

| Metric | Definition |
| --- | --- |
| Expected item coverage | Matched annotated decisions, action candidates and open questions divided by all annotated items. |
| Citation validity | Valid citations divided by all citation slots. An item with no citations adds one missing slot. |
| Unsupported decisions | Decisions with no valid citation, including decisions with an empty citation list. |
| Invented owner/deadline | A matched action candidate where the annotation has `null` and the summary claims a value. |
| Open-question recall | Matched annotated open questions divided by all annotated open questions. |
| Runtime | Per-case and total evaluation time in milliseconds. |
| Case status | `ok`, `below target`, or `FAIL` for citation or attribution errors. |

Replay exits 1 when any citation is invalid or any invented owner/deadline is found;
it exits 0 otherwise. Missed items and coverage below target are reported but do not
change the exit code. Exit 2 means the harness could not run: bad arguments, a missing
or malformed fixture, or a failed gateway response.

Targets come from `Product_spec.md` section 12: at least 90% coverage of annotated
decisions and commitments, and at least 95% of substantive claims with support. The
table and JSON show whether those targets are met, but the exit code stays deliberately
strict only about citation and attribution errors.

## Matching rules

Expected and recorded items are matched one-to-one by lexical overlap. Text is lowercased,
diacritics and punctuation are removed, and Czech and English stopwords are dropped.
Tokens match on equality or a shared prefix of at least five characters. An item matches
when at least 60% of its expected tokens match. This is a lexical proxy, not entailment.
Annotate with the nouns and names the summary should contain, then review misses by hand.
A valid citation ID does not prove the interpretation is correct.

## What it does not measure

- STT or transcription quality. Fixtures start from final text turns; there is no audio.
- Live model behaviour in replay mode. Replay scores a recorded output, so a green run
  proves the harness and the recorded baseline, not the current prompt or model.
- Semantic entailment, usefulness, latency, cost or productivity.
- Real session data. Shipped fixtures are synthetic and labelled in `notes`.

## Fixture format

```json
{
  "name": "explicit decision with owner and deadline",
  "language": "cs",
  "notes": "Synthetic fixture ...",
  "turns": [{ "id": "turn_...", "revision": 1, "startMs": 0, "endMs": 15000, "text": "..." }],
  "expected": {
    "decisions": ["Rozpočet na Q1"],
    "actionCandidates": [{ "text": "Podklady k rozpočtu", "owner": "Petra", "due": "2026-11-15" }],
    "openQuestions": []
  },
  "summary": { "schemaVersion": 1, "overview": {}, "decisions": [], "actionCandidates": [], "openQuestions": [] }
}
```

`summary` is the recorded gateway `content` shape and is never generated at test
time. `transcriptRevision` is optional but recommended; every cited turn must have that
revision. Citations may be turn IDs or `{ "turnId": "...", "turnRevision": 1 }` objects.

## Add a case

1. Copy an existing file in `tests/fixtures/summary-eval/` and give it the next number.
2. Write the final transcript turns with stable IDs, revisions and times.
3. Annotate `expected` with the decisions, commitments and open questions a careful
   human would accept. Use noun phrases the summary should contain; use `null` for an
   unknown owner or a relative deadline that has no confirmed date.
4. Record the summary output, either by hand or with live mode below.
5. Run `npm run eval:summary -- --fixtures tests/fixtures/summary-eval --replay`
   and review every missed item and extra item.

## Commands

```sh
npm run eval:summary -- --fixtures tests/fixtures/summary-eval --replay
npm run eval:summary -- --fixtures tests/fixtures/summary-eval --replay --json
```

`--json` prints the machine-readable report and suppresses the table. The report
contains per-case expected/matched counts, citation errors, invented attributions, missed
items and runtime, plus the aggregate totals and target comparison.

## Live mode

Live mode only reads from the gateway and records a fixture. It is not used by the test
suite or CI.

1. Start the gateway and create a ready summary for the session:
   `npm run session:summary -- <session-id> --request --out /tmp/summary.json`.
2. Record it. `--expected` is optional and copies `name`, `language` and `expected`
   from a hand-written skeleton so annotations are not lost:

```sh
npm run eval:summary -- --live --session ses_... --gateway http://127.0.0.1:8787 \
  --token "$GATEWAY_TOKEN" --record /tmp/live-summary.json \
  --expected tests/fixtures/summary-eval/12-live.json
```

3. Review the recording, fill `expected`, remove identifying data and confirm
   consent. Never commit a real session or token.
4. Copy the reviewed file into `tests/fixtures/summary-eval/` and run replay.

Without `--record`, live mode prints the fixture JSON to stdout. Live mode does not
request a summary; it reads the latest ready one.

## Current baseline

The shipped set has 11 synthetic cases, 20 annotated items and 19 matched (95.0%).
Citation validity is 48/48 (100.0%), unsupported decisions and invented
owner/deadline counts are zero, and open-question recall is 6/6. One long-meeting case
intentionally misses one annotated decision so the below-target path stays visible. This is
a harness baseline, not a measurement of the live model.
