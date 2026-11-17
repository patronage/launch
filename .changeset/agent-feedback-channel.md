---
"@patronage/mcp-core": patch
---

Add an agent feedback channel. Agents file reports with `submit_feedback` and read the answers with `get_feedback`. Maintainers read and answer them over `/mcp/feedback`, which is off unless `FEEDBACK_MAINTAINER_TOKEN` is set.
