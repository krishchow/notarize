# Signature inspection output feedback

Date: 2026-10-20
Source: real Anchor release verification using notarize plugin 1.4.0 in Codex.

The user found `inspect_code_signature` too verbose and asked for more concise next steps. A passing inspection returned a useful short verdict, then a large JSON text block, plus the same data in structuredContent. Twenty passing nested items and raw verification messages obscured the result.

Suggested behavior:

- Default visible output: signed/valid verdict, team and bundle, hardened runtime/ticket, and nested issue count.
- Show details for failures; keep complete nested inventory and raw codesign messages in structured data or an optional verbose mode. Avoid serializing the same full data into visible text too.
- Return at most one relevant next step, or none when this check is complete.
- Make next steps reflect observed state. This app already had a valid stapled ticket, but the tool still suggested notarizing and stapling it. A download simulation can be useful when not yet performed; repeating signing/notarization advice is misleading.

Example passing output:

> Valid Developer ID signature; expected team/bundle; hardened runtime; stapled ticket. 20 nested items, no issues.
> Next: simulate a download if not already checked.

Implemented: signature inspection now keeps the full report in structured content, shows a compact verdict and findings in visible text, and returns at most one follow-up based on the observed ticket state. Team and bundle values are reported without claiming they match an expected identity.
