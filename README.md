# Stele MCP client plugin

Stele MCP の tool を正しい順序で使うための Claude Code / Codex plugin。Document の探索と再取得、Plan・Suggestion・Proposal の連携、変更グループ、楽観ロックの回復、Note・Property・Template・短命 presence・変更 feed・role 境界を `stele-mcp` skill として配布する。

skill は MCP server や API token を自動設定しない。先に Stele MCP へ接続し、その後に plugin または `SKILL.md` を読み込む構成。

## Marketplace から導入する

この repository は配布専用。Stele 本体の source code、運用資料、認証情報は含まない。Stele の利用には別途発行された API token と、対象 Workspace への権限が必要。

Claude Code:

```bash
claude plugin marketplace add athena-campus/stele-plugin --scope user
claude plugin install stele@stele --scope user
```

Codex:

```bash
codex plugin marketplace add athena-campus/stele-plugin
codex plugin add stele@stele
```

導入後、新しい Claude Code / Codex session を開始する。Marketplace 更新後の再導入:

```bash
claude plugin marketplace update stele
claude plugin update stele@stele

codex plugin marketplace upgrade stele
codex plugin add stele@stele
```

## local checkout から Claude Code plugin を読み込む

この README がある Stele source tree の root で次を実行する。

```bash
claude --plugin-dir "$PWD/plugins/stele"
```

`--plugin-dir` はその Claude Code session に plugin を読み込む option。plugin を使う各 session を同じ option 付きで起動する。

## `SKILL.md` を手動で配置する

Marketplace を使わず Claude Code のユーザー共通 skill として配置する場合、Stele の source tree root で次を実行する。

```bash
mkdir -p "$HOME/.claude/skills/stele-mcp"
cp plugins/stele/skills/stele-mcp/SKILL.md \
  "$HOME/.claude/skills/stele-mcp/SKILL.md"
```

特定 project の Claude Code だけで使う場合の配置先は `.claude/skills/stele-mcp/SKILL.md`。

```bash
mkdir -p .claude/skills/stele-mcp
cp plugins/stele/skills/stele-mcp/SKILL.md \
  .claude/skills/stele-mcp/SKILL.md
```

Codex で手動配置する場合は、同じ `SKILL.md` を `$CODEX_HOME/skills/stele-mcp/SKILL.md` または project の `.agents/skills/stele-mcp/SKILL.md` へ配置する。

配置後、新しい Claude Code / Codex session を開始する。

`SKILL.md` の更新時は、公開 docs の ja/en `client-skill.mdx` に埋め込んだ全文も同期する。

## Stele MCP の接続設定

1. Stele の `/settings` で Personal Access Token を発行する。token は `sk_stele_` で始まり、一度だけ表示される。
2. token を `STELE_TOKEN` 環境変数へ設定する。画面へ表示しない入力例:

```bash
read -rs STELE_TOKEN
export STELE_TOKEN
```

3. Claude Code では project scope の `.mcp.json` に Streamable HTTP server を追加する。

```json
{
  "mcpServers": {
    "stele": {
      "type": "http",
      "url": "https://stele-delta.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ${STELE_TOKEN}"
      }
    }
  }
}
```

Codex では bearer token の値ではなく環境変数名を登録する。

```bash
codex mcp add stele \
  --url https://stele-delta.vercel.app/api/mcp \
  --bearer-token-env-var STELE_TOKEN
```

token の平文を source tree、plugin manifest、Marketplace manifest に保存しない。plugin package に `.mcp.json` を同梱しないのは、導入時に bearer token を固定保存せず、各 client の credential 境界で明示設定するため。

接続後、Claude Code の `/mcp` または Codex の MCP 一覧で `stele` が connected になり、42 tool が見えることを確認する。詳細は [Claude Code の MCP setup](https://docs.stele.app/docs/mcp/claude-code) と [API token の発行](https://docs.stele.app/docs/mcp/api-token) を参照。

## Plan watcher

`watcher/watcher.mjs` は `list_plans` を定期 poll し、新しく見つけた `ready` Plan を標準出力と macOS 通知で知らせる pull 型 watcher。Push endpoint や追加 package は不要。既読 ID は endpoint・Workspace・status ごとに `~/.stele/watcher-state.json` へ保存し、API token は保存しない。初回 poll では、既存の対象 Plan も新規として扱う。

API token は環境変数だけで渡す。コマンドライン引数と設定ファイルへ書かない。

```bash
read -rs STELE_API_KEY
export STELE_API_KEY

node plugins/stele/watcher/watcher.mjs \
  --url http://localhost:3033/api/mcp \
  --workspace design-docs \
  --interval 60
```

`STELE_URL` / `STELE_WORKSPACE` / `STELE_POLL_INTERVAL` も各引数の代わりに利用可能。通知は既定で on。明示的な `--notify` または `--no-notify` で切替可能。実運用の `--status` 既定値は `ready`。Web 承認を使えないローカル検証に限り、`--status proposed` で上書き可能。`--once` は cron と単発検証向け。

### 承認後に Claude Code を起動する

外部 command の実行は `--on-ready` 指定時だけの opt-in。watcher は command ごとに `STELE_PLAN_ID` / `STELE_PLAN_TITLE` / `STELE_PLAN_URL` / `STELE_PLAN_STATUS` / `STELE_WORKSPACE` を環境変数で渡す。次の prompt template は、Plan 本文の確認、短命 presence、Suggestion / Proposal の承認ゲート、presence 終了までを 1 回の作業として要求する例。

```text
Stele MCP の Workspace `$STELE_WORKSPACE` で、承認済み Plan ID
`$STELE_PLAN_ID`（$STELE_PLAN_TITLE）に着手する。

1. `read_plan` を Plan ID `$STELE_PLAN_ID` で呼び、status・本文・範囲・完了条件を再確認する。status が ready / active でなければ作業せず報告する。
2. `start_work_session` を workspace `$STELE_WORKSPACE`、plan_id `$STELE_PLAN_ID`、簡潔な focus_text 付きで呼ぶ。返された lease_token はこの session 内だけに保持し、ファイル・ログ・Stele の内容へ書かない。5 分を超える作業では期限前に heartbeat する。
3. Plan 本文に従って対象 Document を読み、作業する。既存 1 Document の変更は planId 付き `create_suggestion`。複数 Document または新規 Document を含む変更は planId 付き Proposal を作り、必要な draft と変更グループを揃え、preview 後に一括提案として submit する。Document 本体へ直接書き込まない。
4. 成果、未完了範囲、作成した Suggestion / Proposal ID を報告する。
5. 成否にかかわらず最後に `finish_work_session` を lease_token 付きで呼ぶ。Plan の完了状態は人間が Web で更新するため、MCP から変更しない。
```

prompt を `claude -p` へ渡す起動例。shell 変数の展開は watcher が command を実行する時点。

```bash
node plugins/stele/watcher/watcher.mjs \
  --workspace design-docs \
  --on-ready 'claude --plugin-dir "$PWD/plugins/stele" -p "Stele MCP で Workspace $STELE_WORKSPACE の Plan $STELE_PLAN_ID（$STELE_PLAN_TITLE）を read_plan して着手。start_work_session で presence を開始し、作業中は必要に応じて heartbeat。成果は planId 付き Suggestion、または複数 Document・新規 Document なら planId 付き Proposal の一括提案として提出。最後に必ず finish_work_session。Plan 状態は変更しない。"'
```

### launchd

token を plist に埋め込まない。ログイン session の launchd 環境へ対話入力で渡した後、`~/Library/LaunchAgents/app.stele.watcher.plist` を読み込む構成。

```bash
read -rs STELE_API_KEY
launchctl setenv STELE_API_KEY "$STELE_API_KEY"
unset STELE_API_KEY
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.stele.watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/stele/watcher/watcher.mjs</string>
    <string>--workspace</string><string>design-docs</string>
    <string>--interval</string><string>60</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/stele-watcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/stele-watcher-error.log</string>
</dict>
</plist>
```

Node の実パスは `command -v node` で確認する。plist 更新後の読込例は `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.stele.watcher.plist`。

### cron

cron では `--once` を毎分起動し、既読 state を共有する方式。token 自体を crontab に書かず、macOS Keychain から実行時に環境変数へ取り出す例。

```cron
* * * * * STELE_API_KEY="$(/usr/bin/security find-generic-password -a "$USER" -s stele-watcher -w)" /usr/local/bin/node /absolute/path/to/stele/watcher/watcher.mjs --workspace design-docs --once >>/tmp/stele-watcher.log 2>>/tmp/stele-watcher-error.log
```

`--on-ready` は任意の shell command を実行できる強い権限。内容を自分で確認した command だけを指定する。command は watcher の環境を継承するため、`STELE_API_KEY` にもアクセス可能。token を出力する command、source tree や state へ保存する command は禁止。外部 command の失敗は警告として記録し、安全のため同じ Plan を自動再実行しない。接続失敗は watcher を終了せず、次回 poll で再試行する。
