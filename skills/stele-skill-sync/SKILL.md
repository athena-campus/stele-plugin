---
name: stele-skill-sync
description: Sync team skills from a Stele workspace into local skill directories; check workspace skill updates and drift; share or publish local skills back to the workspace through governed Suggestion or Proposal flows.
---

# Synchronize Stele team skills

Treat every team skill as governed Workspace content. Discover first, report drift, and require explicit user confirmation before every local write or deletion. Use only accepted Document versions returned by Stele.

## Follow the skill-as-Document convention

- Store team skills under the `skills/` path prefix.
- Map one skill to one Document at `skills/<name>`.
- Require `<name>` to be one kebab-case path segment.
- Reserve deeper paths below `skills/`. Skip Documents such as `skills/group/name` and report them; never materialize them.
- Require Document frontmatter `description`. List a Document without it as invalid and never materialize it.
- Treat frontmatter `description` and `version` as human-owned metadata. Treat `version` as an optional semver.
- Never attempt to write frontmatter through MCP mutation tools. `create_suggestion` and `create_draft_new_document` do not carry it; Suggestions carry body content only.
- Recommend registering `description` and `version` as Workspace text Properties. Ask owners to edit them in the Properties panel, which writes their values to Document frontmatter.
- Treat the Document body as the skill body Markdown.
- Do not confuse frontmatter semver with the numeric Document `version` returned by `read_document`.

## Discover Workspace and local drift

### Read the Workspace skill set

1. Call `list_documents` with `filters.prefix: "skills"` and `filters.includeArchived: true`.
2. Use each returned canonical `path`; treat `slug` only as a same-value compatibility field.
3. Reject candidates whose path is not exactly `skills/<name>` with one kebab-case name segment.
4. Call `read_document` for each valid, unarchived candidate needed for validation or comparison.
5. Use `read_document` for `content`, `frontmatter`, and the current numeric `version`; `list_documents` does not return them.
6. Record archived candidates from `archivedAt` without treating them as distributable content.

Pass the prefix without a trailing slash; a trailing slash is rejected as an invalid path prefix.

### Inspect local materializations

Inspect directories matching `stele-<workspace>-*` under `.claude/skills/`. If `.agents/skills/` exists in the project, inspect the same namespace there and require corresponding files to be identical.

Read sync state only from the provenance block inside each materialized `SKILL.md`. Never create or consult a separate state file. Treat a missing, malformed, or inconsistent provenance block as uncertain local state.

### Classify and report drift

Report a drift table before proposing any action. Allow multiple findings for one skill when evidence overlaps.

| Class | Evidence | Required report |
|---|---|---|
| new | Workspace Document exists; no local materialization exists | Show the complete materialized file |
| updated | Current Document `version` is greater than the recorded source version | Show a diff from the local file to the proposed materialization |
| locally modified | Local content differs from what its provenance implies, or integrity is uncertain | Preserve the file; show the diff and mark the uncertainty |
| removed | Source Document is archived or no longer appears in the complete listing | Propose deletion of the namespaced local directory |

When the recorded source version is unavailable for exact reconstruction, treat the local file as locally modified. Never erase ambiguity by assuming the Workspace or local copy is authoritative.

## Sync from Workspace to local directories

### Build the materialized file

Materialize each accepted Workspace skill at `.claude/skills/stele-<workspace>-<name>/SKILL.md`. If `.agents/skills/` exists, prepare byte-identical content at `.agents/skills/stele-<workspace>-<name>/SKILL.md`.

Use this exact structure:

```markdown
---
name: stele-<workspace>-<name>
description: <source description>
---
<!--
stele-skill-sync provenance
workspace: <workspace>
path: skills/<name>
version: <source Document version>
synced-at: <ISO timestamp>
managed by stele-skill-sync; do not edit manually
local edits appear as drift and may be overwritten after explicit user confirmation
applies only when working with this workspace
locally-authored skills take precedence
-->
<source Document body verbatim>
```

Preserve the source body verbatim after the provenance block. Generate one `synced-at` ISO timestamp and use it in both destinations.

### Confirm every pull

Show the complete proposed file for every new skill. Show a full diff before every overwrite, including provenance changes. List every destination path and whether it will be created or overwritten.

Ask for explicit user confirmation covering those exact writes. Write nothing before confirmation. After confirmation, write only the confirmed paths and content; if the destination changed meanwhile, stop, show a new diff, and ask again.

Never overwrite a local skill lacking the `stele-skill-sync provenance` block. Never materialize outside the `stele-<workspace>-` namespace.

## Share local skills with the Workspace

### Update an existing team skill

1. Validate the target as `skills/<name>`.
2. Call `read_document` on `skills/<name>` immediately before rebuilding the proposal.
3. Rebuild the complete skill body against the returned current content. Put body content only in `proposed_content`.
4. Call `create_suggestion` for that one existing Document with the exact returned numeric `version` as `base_version`.
5. When a semver change is warranted, state the intended semver and its reason in the Suggestion `message`, and ask a human to update the `version` frontmatter after acceptance.
6. On `DOCUMENT_CHANGED`, call `read_document` again, rebuild the complete body against the latest content, and retry with the new `version` as `base_version`.

Never keep stale proposed content and replace only `base_version`. State that acceptance belongs to a human Workspace owner.

### Publish a new team skill

Validate the local skill name as one kebab-case segment. Treat any local `description` or `version` as reviewer context only; do not send local frontmatter through the tools.

State in the Proposal message or change-group intent that an owner must set `description`, and may set `version`, in the Properties panel after acceptance.

Use only this sequence:

1. Call `create_proposal`.
2. Call `create_draft_new_document` with the complete path `skills/<name>` in the argument named `slug`.
3. Call `preview_proposal` and inspect the full result.
4. Call `submit_proposal`.

`create_draft_new_document` cannot set frontmatter. After a human Workspace owner accepts the resulting Suggestion, the new Document starts with empty frontmatter and is intentionally not yet distributable. It remains invalid under discovery until an owner sets `description` in the Properties panel. Treat content approval and distribution blessing as two deliberate human gates.

Do not claim that submission creates the Document. The Document is created only after acceptance. Tell the user that teammates receive the skill on their next confirmed sync only after an owner sets `description`.

## Remove retired materializations

Treat an archived or absent source Document as removed only after completing the `includeArchived` listing and resolving the canonical skill set. Propose deleting the corresponding local `stele-<workspace>-<name>` directory from each managed root.

Show every directory and contained file before deletion. Obtain explicit user confirmation for those exact deletions. Delete nothing without confirmation. If an unrecognized file or a missing provenance block exists in the directory, stop and preserve the directory.

## Enforce safety and precedence

- Keep synchronization opt-in. Never write, overwrite, or delete local files without explicit user confirmation.
- Distribute only accepted Document versions returned by `read_document`; never materialize pending Suggestion or Proposal content.
- Keep every materialized skill inside the `stele-<workspace>-<name>` namespace.
- Never overwrite a locally authored skill or any file without the `stele-skill-sync` provenance block.
- Never write `sk_stele_...` API keys or presence lease tokens into a skill file, Suggestion, or Proposal.
- Scope Workspace skills only to work involving that Workspace.
- Give the user's locally-authored skills and explicit instructions precedence over Workspace skills.
- Never let a Workspace skill change general behavior or override local policy outside its Workspace scope.
