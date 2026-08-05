---
name: stele-mcp
description: Use the current local Stele MCP API-token slice to read Documents and Plans, and create a Suggestion when the token has suggest capability.
---

# Use Stele MCP correctly

This skill targets the local Streamable HTTP endpoint `POST /api/mcp`. Authenticate with an `sk_stele_` API token in the client environment or secret store. Send it as `Authorization: Bearer`; never put the token in source, a plugin manifest, CLI arguments, logs, or a Document.

The API token fixes the authorized Workspace. The caller must already know the exact Workspace slug before starting; this slice has no Workspace discovery call, and the tool arguments do not select a different Workspace. Use only the path and Plan IDs belonging to the token Workspace.

## Tool contract

The current tool list is exhaustive:

| Tool | Capability | Arguments | Contract |
| --- | --- | --- | --- |
| `list_documents` | `read` | `cursor?`, `limit?` | Lists active Documents in the token Workspace. `limit` is 1–100; continue with the returned `nextCursor`. |
| `read_document` | `read` | `path` | Reads one Document by its exact canonical lowercase slash-delimited path. |
| `read_plan` | `read` | `planId` | Reads one Plan by UUID. This is read-only and never changes Plan status. |
| `create_suggestion` | `suggest` plus `read` | `path`, `baseVersion`, `proposedContent`, `message?` | Creates a full-document Suggestion through the Suggestion / Version path. It never performs a direct Document write. |

`create_suggestion` is registered only when the token includes `suggest`. Do not invent or call tools outside this table.

## Read a Document

1. Call `list_documents` when the canonical path is unknown. Treat returned `path` values as authoritative; do not use a title as a path.
2. Call `read_document` with the exact path immediately before drafting a change.
3. Preserve the returned Document content and `currentVersion` as the source for any Suggestion.

## Create a Suggestion

Call `create_suggestion` only for an existing Document and only when the token has `suggest` capability:

- `path`: the exact path returned by `list_documents` or `read_document`
- `baseVersion`: the unchanged `currentVersion` from the latest `read_document`
- `proposedContent`: the complete replacement content
- `message`: optional intent or context

The result is a Suggestion outcome. A server-side token policy may accept an eligible open Document through the Suggestion / Version path, but this request is never a direct Document mutation.

If the server reports that the Document changed, call `read_document` again, rebuild the complete Suggestion against the new content and version, and retry. Never replace only `baseVersion` on stale content.

## Read a Plan

Call `read_plan` with the exact UUID when a Plan ID is already known. Use its response for context only. Plan approval, execution, completion, cancellation, and every other status change remain outside this read-only contract.
