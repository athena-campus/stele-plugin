---
name: stele-skill-sync
description: Team skill synchronization is not supported by the current local Stele MCP API-token slice. Do not use this skill for filesystem or Workspace changes.
---

# Team skill synchronization is unavailable

The current local API-token slice exposes only the read and Suggestion operations documented by `stele-mcp`. It does not provide a team-skill discovery, pull, materialization, publish, or receipt workflow.

Do not run synchronization steps from this skill. Do not create, copy, overwrite, or delete local skill files, and do not call an operation outside the current `stele-mcp` tool contract. If a request requires team skill synchronization, stop and report that the capability is not available in this slice.
