# Stele MCP client plugin

Claude Code / Codex 向けに、Stele MCP の skill と hooks を配布する plugin。MCP 接続は利用者が各 client で設定する。`stele-mcp` は資料取得・変更提案・Plan / Task・活動表示、`stele-skill-sync` は確認済みの Workspace skill の取得と同期報告を扱う。Grok の接続補助は [Grok接続ガイド](grok/README.md) を参照。

## 接続と提供状況

2026-10-14 時点で Hosted の Stele endpoint は未提供（remote deploy 未実施）。公開 URL は確定していない。管理者が実際に起動した環境の接続情報を確認し、client 側で設定する。version 0.10.0 から同梱 MCP 接続設定を撤去している。plugin の導入では MCP server の登録や OAuth 認証を行わない。

- Remote MCP の第一認証経路は OAuth 2.1。client の認証操作から browser を開き、複数 Workspace と必要な capability への同意を行う
- OAuth 非対応 client は connection credential（prefix `sk_stele_conn_`）を Bearer 認証に使う。credential は client の環境変数または secret store で保管する
- 旧 Workspace API token（prefix `sk_stele_`）と旧 single-Workspace OAuth fallback は受理されない
- 認証情報を文書、配布 manifest、CLI 引数、ログへ書かない。接続情報は実環境から取得し、推測で補わない
- 接続後は `tools/list` の公開 schema を確認する。`list_workspaces` の結果にある `id` を対象の `workspaceId` として使う。Workspace 操作に slug を送らない

## Client 側で接続を設定する

利用者自身の環境変数 `STELE_MCP_URL` に管理者から取得した実環境の URL を設定してから、使用する client の手順を実施する。この変数は接続先用であり、credential を含めない。

Claude Code は次のコマンドで server を追加し、`/mcp` から OAuth を開始する。[Claude Code 公式 MCP 手順](https://code.claude.com/docs/en/mcp)

```sh
claude mcp add --transport http --scope local stele "$STELE_MCP_URL"
```

Codex は次のコマンドで server を追加し、OAuth を開始する。[OpenAI 公式 CLI 設定例](https://developers.openai.com/learn/docs-mcp)、[OpenAI 公式 MCP 認証手順](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```sh
codex mcp add stele --url "$STELE_MCP_URL"
codex mcp login stele
```

これらは手動設定の例であり、未提供の Hosted endpoint を作成する操作ではない。OAuth 非対応 client の credential 設定は、その client の公式手順で確認する。接続できたら公開 schema と許可 Workspace を確認する。

## 権限と利用範囲

利用可能な tool 集合は、connection ceiling × credential × Workspace grant × 現在の membership / role の積集合で毎 request 決まる。固定 tool 数を契約にしない。表示された tool も、別 Workspace で利用できるとは限らない。

| capability | 主な用途 |
|---|---|
| `read` | Document / Plan / Task の参照、Workspace skill の取得・同期報告、短命 presence、変更 feed |
| `suggest` | Suggestion / Proposal、Plan の proposed 作成と作者による本文改訂 |
| `interact` | Task の成果報告、条件を満たす AI Task の完了など |
| `archive` | Document のアーカイブ・復元 |
| `tasks:manage` | 人間が明示委任した承認済み Plan 内の Task 管理。`interact` からは導出しない |

接続には横断参照用の `portfolio:read` もある。上表は主要な用途の案内であり、全 tool の固定一覧ではない。

## 基本の流れ

1. `list_workspaces` で対象と実効 capability を確認し、`workspaceId` を保持
2. `list_documents` または `search_documents` で候補を探し、返された canonical `path` で `read_document` を実行
3. 既存 Document 1件の本文変更は `create_suggestion`。直前に取得した `document.currentVersion` を `base_version` に、本文を `proposed_content` に渡す
4. 複数 Document または新規 Document は `create_proposal` → `update_draft` / `create_draft_new_document` → `preview_proposal` → `submit_proposal`。Document 本文への書込みは Suggestion / Proposal 経由のみ
5. 必要なら `create_plan` で意図・範囲・完了条件を宣言。常に `proposed`。`update_plan` は作者による proposed 本文の改訂のみ。Plan の状態遷移・担当変更・質問発行は人間の Web 操作
6. Task は `list_tasks` / `read_task` で依頼と現在版を確認。`report_task_completion` は成果候補の報告で状態を変えない。`complete_task` は条件を満たす `ai_executable` 限定
7. 明示委任と `tasks:manage` が揃う Plan だけで `create_task` / `update_task` / `ask_task_question` / `start_task` を使う。Plan の委任 revision・承認 generation、既存 Task の revision、操作ごとの `requestId` を必ず渡す

presence は `start_work_session` / `heartbeat_work_session` / `finish_work_session` / `list_active_work_sessions`。`read` で使える5分 lease の活動表示で、Task 完了や書込権限の根拠にはならない。`list_workspace_changes` は Workspace の変更 feed。

`list_workspace_skills` / `report_skill_sync` は server 側で実装済み。確認済み snapshot を取得し、実際の読み込みを自己申告する。手順と引数は [stele-mcp](skills/stele-mcp/SKILL.md) と [stele-skill-sync](skills/stele-skill-sync/SKILL.md) を参照。

403 の文言は `Access denied: insufficient role for this workspace` に固定される。role・membership・Workspace の存在を、この応答から推測しない。

## 同梱補助の制限

旧 Plan 承認待ち hooks / watcher は Workspace slug を送る実装が残り、現行 connection schema と一致しない。現行契約での承認待ちは `read_plan` で確認し、人間の Web 操作を待つ。同梱補助の有無を接続・自動実行の保証として扱わない。
