# Stele MCP client plugin

Stele MCP の tool を正しい順序で使うための Claude Code / Codex plugin。Document の探索と再取得、Plan・Suggestion・Proposal の連携、変更グループ、楽観ロックの回復、Note・Property・Template・短命 presence・変更 feed・role 境界を `stele-mcp` skill として配布する。

plugin は Stele MCP server の接続設定と `stele-mcp` skill をまとめて配る。接続設定は endpoint URL だけを持ち、Claude Code / Codex が Stele の OAuth 2.1 metadata を discovery して browser consent を開始する。API token は OAuth を使えない client と watcher の互換経路としてのみ維持する。

## Marketplace から導入する

この repository は配布専用。Stele 本体の source code、運用資料、認証情報は含まない。Stele の利用には Stele account と対象 Workspace への権限が必要。

Claude Code:

```bash
claude plugin marketplace add athena-campus/stele-plugin --scope project
claude plugin install stele@stele --scope project
```

install 後、Claude Code の `/mcp` で `stele` を選び、browser で Stele にログインして接続先 Workspace と capability を承認する。OAuth token は Claude Code が安全に保存し、自動更新する。

Codex:

```bash
codex plugin marketplace add athena-campus/stele-plugin
codex plugin add stele@stele
```

Codex plugin の install authentication で browser consent が始まらない場合は、`codex mcp login stele` を実行する。

導入後、新しい Claude Code / Codex session を開始する。`claude mcp list` / `codex mcp list` に `stele` が出て、OAuth 認証後に connected となれば接続完了。

## 更新する

`claude plugin marketplace add` は既に取得済みの Marketplace には何もしない。更新は専用コマンドを使う。

```bash
claude plugin marketplace update stele
claude plugin update stele@stele --scope project

codex plugin marketplace upgrade stele
codex plugin add stele@stele
```

`claude plugin update` の既定 scope は `user`。導入時と同じ scope を明示しないと `Plugin "stele" is not installed at scope user` で失敗する。

更新の要否は `plugin.json` の `version` で判定される。同じ version のまま内容だけ差し替えても `already at the latest version` となり適用されない。配布側は変更のたびに `.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の `version` を揃えて上げる。

更新後は新しい session を開始する。0.4.0 以前から更新した場合、旧 `STELE_TOKEN` 設定はpluginから参照されなくなる。Claude Code は `/mcp`、Codex は `codex mcp login stele` から OAuth を完了する。

## local checkout から Claude Code plugin を読み込む

この README がある Stele source tree の root で次を実行する。

```bash
claude --plugin-dir "$PWD/plugins/stele"
```

`--plugin-dir` はその Claude Code session に plugin を読み込む option。plugin を使う各 session を同じ option 付きで起動する。

この経路でも URL-only の `stele` MCP server が登録される。Claude Code の `/mcp` から OAuth を完了する。

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

## OAuth 接続

Stele MCP は RFC 9728 Protected Resource Metadata と Supabase Auth OAuth 2.1 Server を公開する。plugin は Authorization header や固定 token を設定せず、client の discovery に任せる。

Claude Code:

1. `/mcp` を開く
2. `stele` を選び、認証を開始
3. browser で Stele にログイン
4. Workspace と `read` / `suggest` / `interact` / `archive` capability を確認して承認

Codex:

```bash
codex mcp login stele
```

認証解除は Claude Code の `/mcp` にある Clear authentication、Codex は `codex mcp logout stele`。Stele 側は `/settings/security` から client 単位で解除できる。

## plugin を使わずに OAuth 接続する

plugin を導入しない client では MCP server を手動登録する。Claude Code は project scope の `.mcp.json` に Streamable HTTP server を追加する。

```json
{
  "mcpServers": {
    "stele": {
      "type": "http",
      "url": "https://stele-delta.vercel.app/api/mcp"
    }
  }
}
```

Codex では URL を登録してから OAuth を開始する。

```bash
codex mcp add stele \
  --url https://stele-delta.vercel.app/api/mcp
codex mcp login stele
```

plugin package、MCP manifest、Marketplace manifest に bearer token、Authorization header、token用 userConfig を保存しない。Claude Code / Codex の dialect を個別検証するため MCP 設定ファイルは分けるが、どちらも同じ endpoint URL だけを持つ。

接続後、Claude Code の `/mcp` または Codex の MCP 一覧で `stele` が connected になり、42 tool が見えることを確認する。

## API token 互換経路

OAuth を実装しない MCP client と Plan watcher では、Stele の `/settings` で発行した `sk_stele_` API token を引き続き利用できる。token を command line 引数、source tree、plugin manifestへ保存しない。

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
