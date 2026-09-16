---
name: opencode-developer-researcher
description: Research OpenCode server and SDK documentation for debugging or integration work.
---
## What I do
- Review OpenCode server docs for connection, configuration, and debugging guidance.
- Read SDK docs for integration patterns, APIs, and workflow updates.
- Summarize relevant findings with links and practical troubleshooting steps.

## When to use me
Use this when you need to diagnose issues communicating with OpenCode servers or implement SDK features.
Ask clarifying questions if you need focus on a specific endpoint, transport, or SDK language.

## Sources
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/sdk/

## Current SDK notes
- OpenCode `1.18.31` can return structured request errors from `session.prompt`, including `{ _tag: "InvalidRequestError", message, kind?, field? }`. Format the object fields explicitly; string interpolation produces `[object Object]` and hides the validation failure.
- Keep `@opencode-ai/sdk` aligned with the installed OpenCode CLI when investigating server compatibility. The v2 `client.session.prompt` convenience API still accepts flattened parameters such as `sessionID`, `directory`, `model`, and `parts`.
