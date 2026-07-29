---
name: stele-mcp
description: Use when invoking Stele MCP tools or writing to a Stele workspace; provides the required document path discovery and move proposals, Plan, Suggestion and Proposal, change grouping, locking, Note, Property, Template, work presence, synchronization, and role workflows.
---

# Use Stele MCP correctly

Follow these workflows whenever reading from or proposing changes to Stele. Treat tool results as workflow state: preserve returned Document paths, Workspace slugs, versions, cursors, and server timestamps exactly where instructed. Use the argument names exposed by the connected tool schema; never invent an argument name that this skill does not specify.

## Connect and resolve the workspace

Start by resolving the Workspace. If the Workspace slug is not already certain, call `list_workspaces` first and use the returned `slug` in every later call. Do not guess a slug from a Workspace name.

## Find and read Documents

Use the canonical lookup sequence for an existing Document:

1. Call `search_documents` or `list_documents`.
2. Select the candidate and take its returned canonical Document `path`. Treat `slug` only as a compatibility field with the same value.
3. Call `read_document` with that path. Never pass a title directly to `read_document`.

Treat search and list results only as candidate metadata. Never compose a change from a search snippet. Before writing, call `read_document` and use its complete content, frontmatter, and version as the canonical current state. If `requested_path` differs from the returned `path`, the requested value was a historical alias; carry the current `path` into later calls.

Know the actual search behavior when choosing a query:

- Queries of 3 or more characters use similarity ranking with weights of title `3`, content `1`, and frontmatter `0.5`.
- Queries shorter than 3 characters use an `ILIKE` fallback.
- The default result limit is `20`; the maximum is `100`.
- Archived Documents are excluded by default.

## Choose the right write path

Make this decision before calling any write tool:

| Scope | Required path |
|---|---|
| Exactly one existing Document | `create_suggestion`, whether the change is small or extensive |
| Multiple Documents | Proposal workflow |
| Any new Document | Proposal workflow |

Do not use a Proposal merely because a one-Document change is large. Do not use `create_suggestion` to create a Document.

### Coordinate longer work with a Plan

Create a Plan before work spanning hours to days when the team needs a shared declaration of intent, scope, and completion criteria. A Plan is optional; small changes may go directly to a Suggestion.

1. Call `create_plan` with the Workspace, a short title, and a Markdown body covering intent, scope, and completion criteria. If requesting an approver, pass only a Stele user ID for an `editor` or `owner` in the same Workspace.
2. Treat the returned Plan as `proposed`. AI clients cannot approve, start, complete, or cancel a Plan; those state transitions belong to humans.
3. Before acting on an existing Plan, use `list_plans` when its ID is unknown, then `read_plan` to verify its current intent and status.
4. Pass the verified Plan ID as `planId` when creating a related Suggestion or Proposal. Omit `planId` when the change does not belong to a Plan.

### Suggest one existing Document change

Read the Document immediately before drafting, then call `create_suggestion` with the proposal based on that full current state. Pass the version returned by `read_document` unchanged as `base_version`.

### Propose a Document path move

External AI never changes a Document path directly. Use this sequence for one Document or a derived Folder prefix:

1. Call `list_documents` and use returned canonical `path` values. Use `filters.prefix` when inspecting a Folder prefix and set `filters.includeArchived: true` so the proposed scope is visible.
2. Call `suggest_move_document_path` with `workspace`, exact `from_path`, exact `to_path`, and an explanatory `message`. Pass `planId` only when the move belongs to a verified Plan.
3. Treat the result as pending human review. Only a Workspace owner can accept or dismiss the path Suggestion; path Suggestions do not support edited acceptance.
4. After resolution, call `read_suggestion_result`, then list or read the Document again and continue with the returned current `path`.

A Folder is derived from Document path prefixes, not stored separately. A prefix move includes active and archived Documents below it. Do not invent empty Folders, mutate each child separately, or assume that an old path can be assigned to another Document.

### Create or update through a Proposal

Use this exact sequence:

1. Call `create_proposal`.
2. For each existing Document, call `read_document`, write the draft against the returned full state, and call `update_draft`.
3. For each new Document, call `create_draft_new_document`.
4. For a large Proposal, call `read_proposal` to collect its draft IDs, then call `set_proposal_groups` with the complete ordered group list before submission. Group drafts by meaningful unit and give every group a title, Markdown-capable intent, and a risk note when a risk exists. This structured declaration improves the quality of human approval.
5. Call `preview_proposal` and inspect the complete result.
6. Call `submit_proposal`.

The only new-Document path is `create_proposal` → `create_draft_new_document` → `submit_proposal`. Submission creates Suggestions; the Document itself is created only when the new-Document Suggestion is accepted.

For a nested new Document, pass its complete slash-separated path in the argument still named `slug`. That argument name is retained for compatibility. Do not use a title as a path, and do not create both a Document path and one of its prefixes as another Document.

A draft Proposal is private to its author. Only that author can list, read, update, or submit it; other users receive NotFound rather than permission details.

`set_proposal_groups` replaces the entire group list. Drafts omitted from every `draftIds` array remain ungrouped, an empty `groups` array removes all groups, and one draft must not appear in multiple groups. Grouping is available only while the author-owned Proposal remains in `draft` status; Stele does not infer groups after submission.

## Handle optimistic locking and recovery

### `DOCUMENT_CHANGED`

Always pass the exact `version` from `read_document` as `base_version`. If `create_suggestion` returns `DOCUMENT_CHANGED`, recover only as follows:

1. Call `read_document` again for the latest content, frontmatter, and version.
2. Rebuild the proposed change against that latest full state.
3. Create the Suggestion again with the new version as `base_version`.

Never keep the old proposed content and replace only its version number.

### `DRAFTS_STALE`

If `submit_proposal` returns `DRAFTS_STALE`, reconcile every stale draft before submitting again:

1. Call `read_document` for every stale Document.
2. Rewrite each affected draft in full against the latest Document state.
3. Call `update_draft` for every affected draft.
4. Call `preview_proposal`, then retry `submit_proposal`.

Do not reconcile only one draft or update version metadata without rewriting the content.

## Target a Markdown section

For a section-targeted Suggestion, set `target_anchor` to the literal Markdown heading exactly as it appears in the Document. The replacement range starts at that heading and continues until the next heading of the same or a higher level. Re-read the Document before choosing the anchor; do not normalize, paraphrase, or partially match it.

## Use Notes

Treat Notes as a Workspace-level idea stream, not as comments attached to a Document.

- Create a top-level Note with `create_note({workspace, body})`. The body must not be empty, and the caller must have at least the `editor` role.
- Omit `kind` or set it only to `"general"`. Do not map natural-language labels such as `"bug"` or `"idea"` into `kind`; Stele MCP accepts only `"general"`, regardless of internal kind or severity concepts.
- Keep replies one level deep. Call `create_note_reply` with the top-level Note ID; never pass a reply ID to create another reply.
- `list_notes` returns open Notes by default, with a default limit of `50` and a maximum of `200`. Continue with `next_cursor` until it is `null`.

## Check Properties and Templates

Before proposing a Property change, call `list_properties` and `read_property` to inspect the existing Workspace schema. A Property change cannot be proposed in a Workspace with zero Documents.

Before creating a Document from a Template:

1. Call `list_templates`.
2. Call `read_template` for the selected Template.
3. Pass its ID as `templateId` to `create_draft_new_document` within a Proposal.

With a Template selected, `content: ""` adopts the Template body. Any non-empty `content` completely overrides the Template body.

## Declare short-lived work presence

Use work presence to show current activity without changing Workspace content or permissions. Presence is informal telemetry, and all four tools require only the `viewer` role.

1. At the start of work, call `start_work_session` with the Workspace. Optionally pass `plan_id`, `document_id`, and a short `focus_text` of at most 160 characters.
2. Keep the returned raw `lease_token` only in the current client session. Stele returns it once, stores only its SHA-256 hash, and cannot recover it later. Do not write it into a Document, Note, Plan, log, or long-term memory.
3. During longer work, call `heartbeat_work_session` every few minutes with that token, before the five-minute lease expires. Each successful heartbeat extends the lease by five minutes from that time.
4. If a heartbeat returns a conflict because the lease ended or expired, discard the old token and call `start_work_session` for a new session. Never retry the stale lease.
5. When the work ends, call `finish_work_session` with the token. Finishing is idempotent while the session row remains available. If finishing is missed, the session automatically disappears from active presence when its five-minute lease expires.

Use `list_active_work_sessions` to see only active, unexpired sessions. It never returns a raw lease token or lease hash. Treat `focus_text` as an informal activity label, not as user or AI identity, and never infer write authority from presence.

## Stay in sync with Workspace changes

Use `list_workspace_changes` as a checkpointed feed:

- On the first call, omitting `since` reads the previous 7 days.
- The default `limit` is `100`; the maximum is `500`.
- Inspect `has_more` before treating the response as complete.
- Save the response `server_time` and pass that exact value as `since` on the next synchronization call.
- Treat `plan` as a supported change kind. Plan entries report `created` or `updated`; status and body changes are both represented as `updated`.

## Respect roles and opaque errors

Treat `viewer` as read-only. Calls in the `create_*`, `update_*`, and `suggest_*` families require a write-capable role and return `403` for a viewer. Creating a Suggestion does not grant resolution authority; acceptance, edited acceptance, and dismissal belong to a Workspace owner.

A `403` response intentionally uses the fixed message `Access denied: insufficient role for this workspace`. Do not infer the caller's role, membership state, or Workspace existence from it, and do not promise the user more detail than the server returns.
