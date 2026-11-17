---
"@patronage/mcp-core": patch
---

`delay` returns at once when its signal is already aborted. An approval that settled before the first progress poll used to wait out the full 1.5 s poll interval before its result was streamed.
