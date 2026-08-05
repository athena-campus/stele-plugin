# Stele MCP client plugin

Stele MCP の現行 local API-token slice を使う Claude Code / Codex plugin。接続設定と `stele-mcp` skill を配布する。`stele-skill-sync` は同梱するが、現行 slice では未対応。

## 現行の接続契約

- MCP endpoint は利用者が起動した local Worker の Streamable HTTP `POST <local-server-url>/api/mcp`。この README に公開 hostname や固定 endpoint を持たせない
- 認証は、`sk_stele_` prefix の対象 Workspace API token を `Authorization: Bearer` として送信。token は client の環境変数または secret store から渡し、source、plugin manifest、CLI 引数、ログへ書かない
- API token の Workspace scope は server 側で固定。Workspace slug は caller が事前に把握し、tool の引数へ別の Workspace を指定しない
- `GET /api/mcp`、未認証 request、read capability のない token は利用不可
- packaged plugin manifest は現行 local API-token slice の接続設定を提供しない。Marketplace 導入や `--plugin-dir` は MCP 接続手順として扱わない

## 現行の tool matrix

| tool | capability | 用途 |
|---|---|---|
| `list_documents` | `read` | token の Workspace にある active Document の一覧。`cursor` / `limit` は任意 |
| `read_document` | `read` | exact canonical path の Document 読み取り |
| `read_plan` | `read` | Plan UUID の読み取り。Plan status は変更しない |
| `create_suggestion` | `suggest`（read も必須） | `baseVersion` に基づく全文 Suggestion。Document 本体への直接書き込みなし |

`create_suggestion` は token に `suggest` capability がある場合だけ表示される。現行 slice の tool list は上記4つだけ。別の tool、Workspace discovery、Plan の作成・状態遷移、team skill 同期を client 側で推測しない。

## Client-local connection

client の project-local MCP configuration へ server URL `<local-server-url>/api/mcp` と `Authorization: Bearer` を設定し、API token は環境変数または secret store から渡す。local server の hostname / port は利用者の起動環境に合わせる。この README は未確認の client 固有設定 syntax を定義しない。plugin package や manifest の URL・tokenを編集して接続先を共有しない。

## 基本 workflow

1. local API Worker を起動し、caller が対象 Workspace slug を確認
2. client-local MCP 設定へ local endpoint を設定し、token を安全な環境変数または secret store へ用意
3. `list_documents` で候補を取得し、返された `path` を保存
4. `read_document` で変更前の全文と `currentVersion` を取得
5. `suggest` capability がある場合だけ、`create_suggestion` に `path`、`baseVersion`、`proposedContent`、任意の `message` を渡す
6. Suggestion の結果を確認。Document 本体は Suggestion / Version 経路でのみ更新

`read_plan` は Plan の確認専用。Plan の承認・開始・完了・取消や、その他の status 操作を MCP から実行しない。

## `stele-skill-sync` について

Workspace の team skill を探索・materialize・公開する同期機能は現行 local API-token slice の対象外。`stele-skill-sync` skill は未対応を示すためだけに同梱し、local skill の作成・コピー・上書き・削除や同期用 tool の呼び出しを行わない。
