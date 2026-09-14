# Grok と Stele をつなぐ

既存Grok CLIから、選んだTaskと資料を読み、成果をSteleへ返す接続。専用Runnerや常駐サーバーの追加は不要。対象はGrok 1.0.30。公開tool schemaは接続先の `tools/list` を正とする。

現在は検証中。2026-09-15の合成実行ではTask読取は成功したが、追加contextが届かず成果報告には至っていない。toolイベントのturn識別子が欠ける場合の互換処理を追加し、ローカルテストを通した。実Grokでの修正後の往復確認は別途必要。

## 初回設定

1. Steleの「設定 → MCP接続」でGrok用の接続を作り、必要なWorkspaceだけを許可する。活動と資料参照には `read`、成果報告には `interact` が必要。短い有効期限から始める。
2. 下の設定JSONをローカルに作る。projectRootはGit repositoryのrootを指定する（Grok 1.0.30はGit管理外のproject hooksを読み込まない）。credentialはJSONへ書かず、起動するshellの環境変数へ渡す。
3. `node plugins/stele/grok/configure.mjs /absolute/path/stele-grok.json` を実行する。既存 `.grok/config.toml` や `hooks/stele.json` は上書きしない。既存設定へ加える場合は `--preview` の出力からMCP節とhooksを手動で併合する。
4. 対象projectで `grok inspect` を実行し、接続先・hooks・project trustを確認する。`grok mcp doctor stele` で接続を確認する。inspectやログに認証情報が含まれ得るため、そのまま共有しない。

```json
{
  "version": 1,
  "endpoint": "http://127.0.0.1:8788/api/mcp",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "taskId": "22222222-2222-4222-8222-222222222222",
  "documentPaths": ["project/spec"],
  "projectRoot": "/absolute/path/to/project",
  "stateDirectory": "/absolute/private/path/stele-grok-state",
  "credentialEnv": "STELE_MCP_TOKEN"
}
```

UUIDは実際の対象に置き換える。必要な場合だけ `planId` を追加する。資料は最大3件。外部接続はHTTPS、HTTPはloopbackのみ。stateDirectoryはprojectの外にある本人所有の専用directory（権限700）を使う。leaseを含むstate fileは600で保存し、credentialは保存しない。設定・state・ログをGitへ追加しない。

## 毎回の流れ

HUBで資料を確認し、Task detailで頼む内容と成果の判定条件を決める。設定のTask・資料を合わせ、Grokへ次の形で依頼する。

> まずSteleのread_taskで、指定したworkspaceIdとtaskIdの依頼を読んでください。指定資料を確認して依頼を進め、確認できた結果・検証・残作業をreport_task_completionでこのTaskへ返してください。Taskの完了判断は私が行います。

最初のtool操作の後、hookが指定Task・Plan・資料をMCPで取得し、追加contextへ渡す。Grok 1.0.30ではUserPromptSubmitのstdoutはmodelへ届かない。toolを使わず回答した場合、この補助contextも届かないため、Task readを入口にする。

通常のGrokを使う。headlessでは依頼文をfileへ保存し、確認済みmodelを固定する。例: `grok --cwd /path/to/project --model grok-4.6 --prompt-file /path/to/request.md --sandbox strict`。ローカルファイルやMCPの許可範囲は作業ごとに限定する。Steleのread権限はローカルファイル編集権限を与えない。

成果はTask detailの成果欄、Homeの判断待ちから読む。停止だけでは成果投稿もTask完了も行わない。追加修正は同じTaskを指定して再依頼する。資料の変更提案・Task自動完了はこのhookには含めない。

## 活動表示と失敗回復

- UserPromptSubmitとtool操作でPresenceを開始・延長し、停止・失敗・中断・SessionEndで終了する。遅延した別promptIdの終了通知は現在の作業を閉じない。直近32turnを重複抑制する。
- toolイベントにpromptIdがない場合、PreToolUseでtoolUseIdと開始済みのturnを対応づける（直近128call）。PostToolUse単独では現在turnを借用しない。終了済み・別turnの既知callは無視する。識別子なしの未観測PreToolUse自体が次turnへ遅れて届く場合は区別できないため、同じsessionでは前の依頼の終了を待って次を送る。
- tool操作が5分以上ない推論、強制終了、通信断ではPresenceが期限切れになる。Taskの「進行中」は別の記録として残る。別のStop gateとの併用では継続と最終停止を区別できないため、活動表示を完了判定に使わない。
- 通信は全体10秒・各request 2.5秒で打ち切り、Grok操作は継続する。hook unavailableが出たら接続・有効期限・grantを確認し、次の依頼で読み直す。失敗を成功として報告しない。
- 強制killでstateDirectoryに `.lock` が残った場合、対象Grok/hookが終了していることを確認して、そのsessionのlockだけを削除する。ほかのsessionやcredentialは消さない。残ったPresenceは5分で失効する。
- 解除は追加した `hooks/stele.json` と `mcp_servers.stele` 節だけを除去し、Steleで専用credentialを失効する。ほかの設定は保持する。

## 2週間の確認

1日1件、小さな実際のTaskで「依頼 → 資料参照 → 成果 → 判断」を回す。日付、Task link、参照資料、成果の有無、やり直しや別ツールへ移った理由を短く残す。1週目は接続と帰り道、2週目は資料を読ませた効果と継続利用を確認する。使わなくなったら、追加機能より先に止まった箇所を確かめる。利用継続の実績は合成fixtureの検証と別に判定する。

## 開発確認

`node --test grok/*.test.mjs`。実Grok往復は親repositoryの `apps/api/scripts/verify-live-grok-hooks.mjs` を使う。事前にCLI/model/inspectを確認し、合成資料だけをGrokへ送る。global設定は変更しない。

`STELE_QA_REPLAY_HOOKS_ONLY=1`ではGrok/modelを起動せず、合成イベントをhook実行ファイルへ送り、実ローカルMCPでcontextとPresenceを検証する。この結果は実Grokの受信・成果報告の証拠にはならない。通常の実Grok検証はstrictのまま。明示承認がある単発合成検証だけ `STELE_QA_ALLOW_UNSANDBOXED=1` を指定でき、使用済みreceiptを上書きして再実行しない。
