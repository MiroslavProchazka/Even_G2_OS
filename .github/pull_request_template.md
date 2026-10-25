## Summary

One paragraph on what this changes and why.

## What changed

- ...

## Verification

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npx tsc --noEmit`
- [ ] Hardware test on G2. What I saw:
- [ ] Not verified. Why:

A green build, a passing test or an `.ehpk` is not evidence of glasses or provider behaviour. State what you actually exercised.

## Risk

What can break, for whom, and how it would show. Mention an open finding from `docs/REVIEW.md` or `docs/AUDIT.md` when relevant.

## Checklist

- [ ] No token, API key, `.env`, `app.device.json` or `.ehpk` in the diff.
- [ ] `CHANGELOG.md` updated under `Unreleased`.
- [ ] A regression test covers every behavioural fix.
- [ ] CodeQL alerts are fixed or justified.
- [ ] Documentation updated when behaviour, limits or configuration changed.
