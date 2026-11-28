---
"notarize-mcp": minor
---

Add `submit_feedback`, so agents can report problems with notarize's own tools to an mcp-feedback hub you name in `NOTARIZE_MCP_FEEDBACK_ENDPOINT` or the shared `MCP_FEEDBACK_ENDPOINT`; each report is shown to the user first, and nothing is sent when neither is set.
