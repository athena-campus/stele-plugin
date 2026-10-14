---
name: stele-mcp
description: Use Stele connection-native MCP to read Workspace resources, propose Document changes, coordinate Plans and delegated Tasks, report results, and manage short-lived presence.
---

# Use Stele MCP correctly

## Connect and select a Workspace

As of 2026-10-14, the Hosted Stele endpoint is not provided: remote deployment has not occurred. Obtain connection details from the administrator of an actually running environment. Do not guess a public URL. Version 0.10.0 distributes skills and hooks without bundled MCP connection configuration. Users must register and authenticate the MCP server in each client; installing this plugin does not establish a connection.

Use the official client instructions for manual connection setup: [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). The README provides verified CLI examples using the user-supplied URL; never invent client configuration syntax.

Remote MCP uses OAuth 2.1 first, with consent for multiple Workspaces and capabilities. Clients without OAuth use a connection credential with prefix `sk_stele_conn_` as a Bearer credential, held in the client environment or secret store. Retired Workspace tokens with prefix `sk_stele_` and the old single-Workspace OAuth fallback are rejected. Never put credential values in content, manifests, CLI arguments, or logs.

Inspect `tools/list` before acting. The available tool set is resolved on every request from the intersection of connection ceiling, credential, Workspace grant, and current membership / role. There is no fixed tool count. A tool visible because of one Workspace does not confer permission in another.

Call `list_workspaces({})`; select a returned `id` and retain its `effectiveCapabilities`. All Workspace tools below require that exact UUID as `workspaceId`. Do not send a `workspace` slug. Recheck authorization when a grant, credential, or membership changes.

## Documented tool arguments

This is a workflow subset, not an exhaustive registry. Use only tools exposed by the connection. `?` means optional. Every row except `list_workspaces` requires `workspaceId` in addition to the arguments shown.

| Tool | Capability | Arguments besides `workspaceId` |
| --- | --- | --- |
| `list_workspaces` | `read` | none; no Workspace selector |
| `list_documents` | `read` | `cursor?`, `limit?`, `filters?` (`includeArchived?`, `prefix?`, `props?`) |
| `search_documents` | `read` | `query`, `cursor?`, `limit?`, `includeArchived?`, `filters?` (`includeArchived?`) |
| `read_document` | `read` | `path` |
| `create_suggestion` | `suggest` | `path`, `base_version`, `proposed_content`, `message?`, `planId?`, `targetType?`, `targetAnchor?`, `blockId?` |
| `read_suggestion_result` | `read` | `suggestionId` |
| `create_proposal` | `suggest` | `title`, `description?`, `planId?` |
| `update_draft` | `suggest` | `proposal_id`, `document`, `base_version`, `content` |
| `create_draft_new_document` | `suggest` | `proposal_id`, `slug`, `title`, `content`, `templateId?` |
| `read_proposal` / `preview_proposal` | `read` | `proposalId` |
| `set_proposal_groups` | `suggest` | `proposal_id`, `groups` (items: `title`, `intent`, `draftIds`, `riskNote?`) |
| `submit_proposal` | `suggest` | `proposal_id` |
| `list_plans` | `read` | `status?` (one status or an array), `limit?` |
| `read_plan` | `read` | `planId` |
| `create_plan` | `suggest` | `title`, `body`, `requestedApproverId?` |
| `update_plan` | `suggest` | `planId`, `body`, `addressedClarificationIds?` |
| `list_tasks` | `read` | `planId?`, `status?`, `limit?` |
| `read_task` | `read` | `taskId` |
| `report_task_completion` / `complete_task` | `interact` | `taskId`, `summary`, `artifactReferences?` (array of strings) |
| `create_task` | `tasks:manage` | authority fields below; `title`, `body`, `executionLane`, `dependsOnTaskIds?` |
| `update_task` | `tasks:manage` | authority and existing Task fields below; `title`, `body`, `sourceQuestionIds?` |
| `ask_task_question` | `tasks:manage` | authority and existing Task fields below; `body`, `blocking` |
| `start_task` | `tasks:manage` | authority and existing Task fields below |
| `start_work_session` | `read` | `plan_id?`, `document_id?`, `focus_text?` (at most 160 characters) |
| `heartbeat_work_session` / `finish_work_session` | `read` | `lease_token` |
| `list_active_work_sessions` | `read` | none |
| `list_workspace_changes` | `read` | `since?`, `kinds?`, `limit?` |
| `list_workspace_skills` | `read` | `document?`, `include_invalid?` |
| `report_skill_sync` | `read` | `document`, `mode`, `observation`, `confirmation_id?`, `observed_digest?` |

Task authority fields: `planId`, `expectedDelegationRevision`, `expectedApprovalGeneration`, `requestId` (UUID), all required. Existing Task fields: `taskId`, `expectedRevision`, both required for update, question, and start. Creation has no existing Task revision; it still requires the Plan authority revisions.

`read` also permits presence and sync self-reports without granting content write authority. `suggest` permits content proposals and limited Plan edits; `interact` permits result reporting and eligible AI completion. `archive` is a separate Document archive/restore capability. `tasks:manage` is explicit at each authorization layer, never inferred from `interact`. Cross-Workspace portfolio reads additionally use `portfolio:read`.

## Read before proposing a change

1. Find candidates with `list_documents` or `search_documents`, then preserve the returned canonical `path`.
2. Call `read_document({workspaceId, path})` immediately before drafting. Use the full `document.content` and `document.currentVersion`; a search snippet is not the source text.
3. For exactly one existing Document's content, use `create_suggestion` with the exact `base_version` and `proposed_content`. For `targetType: "section"`, pass a literal Markdown heading as `targetAnchor`; for `"block"`, supply `blockId`. Otherwise use the full replacement content.
4. Inspect the outcome, then use `read_suggestion_result` when checking human resolution. Do not treat proposal creation as acceptance.

Document content writes go through Suggestion / Proposal only. The connection-native `create_suggestion` accepts content changes; it does not accept a frontmatter patch or create a new Document. Do not infer fields from a legacy schema. On a stale-version error, re-read the full Document and rebuild the content before resending; never change only the version on an old proposal.

## Propose multiple Documents or a new Document

1. Create a draft with `create_proposal`.
2. For each existing Document, read the latest full content and call `update_draft` with its canonical path as `document`, version as `base_version`, and proposed content as `content`.
3. For each new Document, call `create_draft_new_document`. The field still named `slug` holds the complete canonical path. Inspect existing prefixes before selecting it; do not use a title as a path.
4. For meaningful change groups, read draft IDs using `read_proposal`, then call `set_proposal_groups` with the complete `groups` array. Each item has `title`, `intent`, `draftIds`, and an optional nullable `riskNote`. Omitted drafts remain ungrouped; do not repeat a draft in multiple groups.
5. Inspect `preview_proposal`, then call `submit_proposal`. Submission creates pending Suggestions; a new Document exists only after acceptance.

Only the author can modify or submit a draft Proposal. When drafts are stale, re-read every affected Document, rebuild each affected draft, preview again, and submit. Keep `proposalId` for reads distinct from `proposal_id` for writes.

## Coordinate with a Plan

Plans are optional declarations of intent, scope, and completion criteria. `create_plan` always creates `proposed`. If specifying `requestedApproverId`, use the user ID of a current owner in the selected Workspace, never a display name or email address.

Use `list_plans` and `read_plan` for current scope, status, delegation, and server guidance. A proposed Plan is not executable until a human approves it. Follow `guidance`: a runtime that can wait may maintain presence and poll at 60–90 seconds; otherwise report the pending decision and recheck next session.

`update_plan` replaces the entire body only while the Plan is proposed and only by its author. To answer Plan questions, include only the answered open question IDs in `addressedClarificationIds`; omission or `[]` leaves them open. Re-read after a conflict. Plan approval, start, completion, cancellation, assignment changes, and question issuance are human Web actions. Task question tools do not issue Plan questions.

Pass a verified `planId` to a related Suggestion or Proposal. Plan and Task dependencies are separate relationships; do not infer nested Plans.

## Read Tasks and return results

Use `list_tasks` / `read_task` to verify the current request, `revision`, dependencies, questions, execution lane, and Plan context. Respect the server's `nextAction` rather than deriving a new state locally.

- `report_task_completion` appends a completion candidate for either lane and leaves Task state unchanged. Include actual result evidence in `summary` and stable result references in `artifactReferences`.
- `complete_task` is limited to `ai_executable`, with live `interact` authority, an active Task, no open questions, no unfinished dependencies, and a non-terminal Plan. A human judgment Task must be completed by a human.
- Task completion does not complete a Plan, accept a Suggestion, or start another Agent. An expired delegation cannot be bypassed using the completion tools on a Plan that has delegation history.

## Manage Tasks only inside an explicitly delegated Plan

An owner must explicitly delegate Task management in an approved Plan. Capability consent alone is insufficient. Re-read `read_plan` for `plan.taskDelegation.revision` and `plan.approvalGeneration`, passing them as `expectedDelegationRevision` and `expectedApprovalGeneration`. Read an existing Task's `task.revision` as `expectedRevision`.

1. For `create_task`, declare `executionLane` as `ai_executable` or `human_judgment`. Use `dependsOnTaskIds` only for existing prerequisites in that Plan. Assignment is the connection's delegating member; do not invent an assignee argument.
2. For `update_task`, provide the full `title` and `body`. `sourceQuestionIds` records answered human questions applied by the update. It does not answer or close questions.
3. For `ask_task_question`, explain the question and context in `body`; use `blocking: true` only when this Task must wait for the answer. Independent Tasks may continue. Human answers remain human Web actions.
4. `start_task` records starting an eligible `ai_executable` Task with satisfied prerequisites and answered blocking questions. It does not launch an Agent or start the Plan.

Use a fresh `requestId` for a new operation. Reuse it only when resending the same unchanged request after a lost response. If revisions, approval, or permission changed, re-read and reassess the authorized scope; do not replace revision numbers on stale work. These tools cannot change an existing execution lane, assignee, Plan scope, dependency edges, or human answers.

## Presence, changes, and skill synchronization

Start presence with `start_work_session`, keep the returned `lease_token` private to the current session, and heartbeat before its five-minute lease expires. Every presence call includes `workspaceId`. An ended or expired lease requires a new session; do not retry it. Finish when done; finish is idempotent while the current credential and grant still authorize the lease. `list_active_work_sessions` lists only active, unexpired sessions. Presence does not prove Task completion or grant write authority.

For `list_workspace_changes`, an omitted `since` reads the last seven days; default `limit` is 100, maximum 500. `kinds` may contain `document`, `note`, `suggestion`, `property`, `plan`. Inspect `has_more`: if true, keep the same `since` and increase the limit. If still truncated at the maximum, report incomplete coverage and retain the checkpoint. Only after covering the window, save the returned `server_time` for the next `since`.

`list_workspace_skills` and `report_skill_sync` are implemented server-side. Use the companion `stele-skill-sync` skill for confirmed snapshot selection, local or in-session loading, and honest receipt reporting.

## Opaque authorization failures

A 403 uses the fixed message `Access denied: insufficient role for this workspace`. Do not infer the role, membership state, or Workspace existence from it. Report the denied operation and ask the connection owner to check consent/grants in the Web UI; do not retry with another Workspace or credential without authorization.
