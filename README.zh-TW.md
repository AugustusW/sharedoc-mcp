# sharedoc-mcp

> **Agent 產出的 Markdown → 一條可以交給任何人的連結。今天用 GitHub gist，明天用你自己的 server。**

[English](./README.md) | 繁體中文

[![npm](https://img.shields.io/npm/v/sharedoc-mcp?color=brightgreen)](https://www.npmjs.com/package/sharedoc-mcp)
[![Release](https://img.shields.io/github/v/release/AugustusW/sharedoc-mcp?color=brightgreen)](https://github.com/AugustusW/sharedoc-mcp/releases)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-blue.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-orange.svg)](https://modelcontextprotocol.io/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-orange.svg)](https://claude.com/claude-code)
[![Codex](https://img.shields.io/badge/Codex-compatible-black.svg)](https://developers.openai.com/codex/)

一個 [MCP](https://modelcontextprotocol.io/) stdio server——可用於 [Claude Code](https://claude.com/claude-code)、Codex CLI 與任何 MCP client——給你的 agent **8 個工具：發佈、更新、搜尋、撤銷分享文件**。同一組介面、兩個可切換後端：**gist**（零設定，搭你已登入的 `gh` CLI）與 **selfhost**（SQLite 存你機器上，支援密碼與強制期限）。

> 後端不支援某參數時（如 gist 收到 `password`）會回明確錯誤，不會靜默忽略。

## 為什麼？

AI agent 整天在產 Markdown——報告、研究摘要、會議記錄。要交給另一個人，通常得把一大面文字牆貼進聊天視窗。

```text
沒有 sharedoc-mcp                     有 sharedoc-mcp
─────────────────                     ────────────────
複製一大段文字貼進聊天                  「把這個做成分享文件」
每多一個人就再貼一次                    一條連結給所有人
內容埋在聊天記錄裡                      事後可撤銷／延長／追加
「可以加密碼嗎？」……不行                selfhost 後端：bcrypt + 期限
```

## 特色

- ✓ 8 個 MCP 工具：建立／追加／延長／改密碼／改標題／撤銷／刪除／搜尋
- ✓ `sharedoc-mcp serve` daemon 模式——MCP client 關掉後 selfhost 連結照樣活著
- ✓ 內容搜尋：用文件裡寫了什麼找回舊連結，不只靠標題
- ✓ `GET /healthz`——帶身分識別的健檢端點，外部監控／自動重啟直接掛
- ✓ 兩個後端、同一組介面——一個環境變數切換，工具 schema 完全相同
- ✓ **Gist 後端**（預設）：secret gist 走你已登入的 `gh` CLI——不用管 token、不用架任何東西
- ✓ **Selfhost 後端**：文件留在你機器上（內建 `node:sqlite`——零原生模組）
- ✓ Server 端密碼驗證（bcrypt）+ 錯誤嘗試限流——5 次/分鐘，HTTP 429，計數存 SQLite、重啟不歸零（selfhost）
- ✓ 強制期限（410）與撤銷 7 天內容清除緩衝（selfhost）；惰性過期清理（gist）
- ✓ Markdown 經 `marked` + `sanitize-html` 渲染——分享內容中的 script、事件屬性、`javascript:` 連結都會被剝除
- ✓ Viewer **只 bind 127.0.0.1**，所有回應帶完整安全 headers（CSP `default-src 'none'`、nosniff、禁 iframe、no-referrer、no-store）——對外曝光交給你自己控制的 tunnel（食譜見下）
- ✓ 本地索引支援 `search_shared_docs` 與建立去重（5 分鐘內相同的無保護重試回同一 URL；補加密碼/期限的重試一律建新文件）
- ✓ 兩個 MCP client 可共用同一資料目錄：SQLite WAL + busy timeout、埠衝突優雅共存
- ✓ 60 個離線測試；乾淨 checkout `npm test` 直接綠

## 安裝

需要 Node.js ≥ 22.13.0。gist 後端另需已登入的 [GitHub CLI](https://cli.github.com)（`gh auth login`）。

**方式 A — Claude Code（一行）：**

```bash
claude mcp add sharedoc --scope user -- npx -y sharedoc-mcp
```

**方式 B — Codex CLI**（`~/.codex/config.toml`）：

```toml
[mcp_servers.sharedoc]
command = "npx"
args = ["-y", "sharedoc-mcp"]
```

**方式 C — 其他 MCP client：**以 stdio server 執行 `npx -y sharedoc-mcp`。

## 選後端

| | 🅰 `gist`（預設） | 🅱 `selfhost` |
|---|---|---|
| 設定 | 無——用你已登入的 `gh` CLI | 無額外設定——資料留在你機器上 |
| 文件放在 | GitHub（secret gist） | 你的機器（SQLite） |
| 連結可達性 | 任何地方、立即 | localhost——對外分享請接 tunnel |
| 密碼 | ✗（secret URL 本身就是保護） | ✓ server 端驗證（bcrypt）+ 限流 |
| 期限 | 惰性——過期 gist 於下次使用時刪除 | 強制——過期連結回 410 |
| 撤銷 | gist 立即刪除、不可逆 | 立即 410，內容 7 天緩衝後清除 |

### Gist 快速開始

跟 agent 說「把這個做成分享文件」——它呼叫 `create_shared_doc` 回傳 secret gist URL。Secret gist 不會被公開列出、網址無法猜測，但**拿到連結的任何人都能讀**——這就是此後端的完整安全模型。需要密碼請用 `selfhost`。

本地索引（`~/.config/sharedoc-mcp/index.json`）記錄分享過的內容，供搜尋與過期清理。此後端的期限是*惰性*的：過期 gist 於下次任一工具執行時刪除，不是到期那一刻。

### Selfhost 快速開始

```bash
claude mcp add sharedoc --scope user --env SHAREDOC_BACKEND=selfhost -- npx -y sharedoc-mcp
```

文件存在 `~/.local/share/sharedoc-mcp/` 的 SQLite；viewer 於 `http://127.0.0.1:8377` 服務。要分享到機器之外，前面接一個 tunnel 並設定 `SHAREDOC_PUBLIC_URL`：

> **讓連結活得比編輯器久：**MCP 模式下 viewer 跟著 MCP client 一起關——關掉 Claude Code，selfhost 連結就暫時打不開（資料安全存在 SQLite，下次開就恢復）。要連結全天候在線，跑獨立 daemon：
>
> ```bash
> npx -y sharedoc-mcp serve   # 只跑 viewer、共用同一個 DB——用 launchd/systemd/tmux 常駐
> ```
>
> MCP client 偵測到 daemon 已佔埠就直接沿用它。
>
> **什麼時候該設：**第一次把連結交給別人的那一刻——跟 tunnel 一起設（兩者都該常駐，如 launchd/systemd）。在那之前 MCP 模式的 viewer 就夠用；gist 後端使用者則永遠不需要。

| 食譜 | 適合 | 設定 |
|---|---|---|
| **Tailscale 私有連線**（推薦） | 收件人是自己的裝置／可邀進 tailnet 的人 | `tailscale serve --bg 8377` → `https://<機器>.<tailnet>.ts.net`，**只有 tailnet 內可達**——完全不暴露到公網 |
| **Tailscale Funnel** | 要分享給任何人、沒網域 | `tailscale funnel 8377` → 同一條固定網址，但公開 |
| **Cloudflare named tunnel** | 有自己的網域 | 網域掛 Cloudflare，`cloudflared tunnel create` + 主機名 route 到 `http://127.0.0.1:8377` |
| **cloudflared quick tunnel** | 臨時分享 | `cloudflared tunnel --url http://127.0.0.1:8377` → 隨機網址，每次重啟會變 |

#### 有自己的網域？Cloudflare named tunnel 逐步版

品牌化的固定分享網址，例如 `https://docs.example.com/docs/<uuid>`——TLS 由 Cloudflare 處理、機器在 NAT 後面也通：

```bash
# 一次性設定（網域已掛進 Cloudflare——免費方案就夠）
cloudflared tunnel login
cloudflared tunnel create sharedoc
cloudflared tunnel route dns sharedoc docs.example.com
```

`~/.cloudflared/config.yml`：

```yaml
tunnel: sharedoc
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: docs.example.com
    service: http://127.0.0.1:8377
  - service: http_status:404
```

跑 `cloudflared tunnel run sharedoc`（要常駐就裝成 service），MCP 註冊時帶上公開網址：

```bash
claude mcp add sharedoc --scope user \
  --env SHAREDOC_BACKEND=selfhost \
  --env SHAREDOC_PUBLIC_URL=https://docs.example.com \
  -- npx -y sharedoc-mcp
```

順帶解鎖：Cloudflare 的 DDoS 防護免費附送；可疊 WAF 規則，或在分享路徑以外套 [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/)（SSO）——變成「內部走 SSO、對外分享靠密碼」的雙層結構。

**另一種情境——不想依賴家裡機器常開：**把 sharedoc-mcp 跑在 VPS 上（agent 也在那執行），nginx/caddy 反代 `127.0.0.1:8377` 配網域與自動 TLS 即可，不需要 tunnel。

環境變數：

| 變數 | 預設 | 意義 |
|---|---|---|
| `SHAREDOC_BACKEND` | `gist` | `gist` 或 `selfhost` |
| `SHAREDOC_PORT` | `8377` | viewer 埠（selfhost） |
| `SHAREDOC_PUBLIC_URL` | `http://127.0.0.1:<port>` | 分享連結的網址前綴——設成你的 tunnel 主機名 |
| `SHAREDOC_DATA_DIR` | `~/.local/share/sharedoc-mcp` | SQLite 位置（selfhost） |
| `SHAREDOC_INDEX_PATH` | `~/.config/sharedoc-mcp/index.json` | 本地索引（gist） |
| `MCP_CALLER` | — | 建立文件的預設作者歸因 |

## 8 個工具

| 工具 | 功能 |
|---|---|
| `create_shared_doc` | 標題 + Markdown（+ 選填密碼 / `expires_in_hours` / 作者）→ 分享 URL |
| `append_to_shared_doc` | 尾端追加 Markdown（非冪等——重試會加兩次） |
| `extend_shared_doc` | 延長期限 N 小時 |
| `reset_shared_doc_password` | 設定／更換／移除（null）密碼（僅 selfhost） |
| `update_shared_doc_title` | 改標題 |
| `revoke_shared_doc` | 撤銷連結、保留紀錄（語意見後端對照表） |
| `delete_shared_doc` | 連結失效＋紀錄整個消失——不可逆 |
| `search_shared_docs` | 不帶參數＝列出最新連結；標題子字串、內文搜尋（selfhost 全文；gist 僅開頭摘要）、狀態篩選 |

## 隱私

各後端的資料流：

- **Gist 後端**：文件內容以 secret gist 上傳到你 GitHub 帳號下——適用 GitHub 的條款與保存政策。本地索引（標題、URL、時間戳——不含內容）留在 `~/.config/sharedoc-mcp/`。除了經你自己的 `gh` CLI 送 GitHub 之外，不送任何地方。
- **Selfhost 後端**：內容不離開你的機器，除非你接了 tunnel——那之後就是「拿到連結的人 + 中繼流量的 tunnel 供應商」可及。密碼只以 bcrypt 雜湊儲存。
- sharedoc-mcp 本身無遙測、不呼叫任何自己的第三方服務。

## 安全語意（誠實版）

- **Gist 連結即權限**：拿到 URL 就能讀。撤銷＝立即刪除 gist、不可逆。
- Selfhost 密碼於 server 端驗證通過才吐內容；錯誤嘗試限流（每來源+文件 5 次/分鐘），計數存 SQLite——重啟 server 不會歸零。**經 tunnel 時所有外部訪客共用同一來源位址**，實際效果是每份文件 5 次/分鐘——比逐訪客更嚴格；一個人打錯幾次會讓該文件對其他人短暫鎖定。
- 刻意**沒有檔案分享工具**：可傳任意路徑的「分享這個檔案」工具是 prompt injection 的洩密面（`.env`、金鑰）——被劫持的 agent 可以直接把機敏檔發佈出去。與其做 allowlist 不如整個拿掉。
- Viewer 永遠只 bind 127.0.0.1。它是否、如何觸及網際網路，完全由你的 tunnel 設定決定。

## 開發

```bash
git clone https://github.com/AugustusW/sharedoc-mcp.git
cd sharedoc-mcp
npm install
npm test        # 先 build 再跑 60 個離線測試——gh CLI 以 mock 替身，HTTP 測試只打 127.0.0.1
```

版本規則：每次釋出 bump `package.json` 的 `version`、加一筆 [CHANGELOG](./CHANGELOG.md)、打 git tag 發 [GitHub Release](https://github.com/AugustusW/sharedoc-mcp/releases) + [npm](https://www.npmjs.com/package/sharedoc-mcp)。
**想收到更新通知**：Watch 本 repo（Custom → Releases）。`npx -y` 每次冷啟動會抓最新已發佈版本；你的索引與文件 DB 都在套件外——更新永遠不會動到它們。

## 狀態

v2.0.0（[CHANGELOG](./CHANGELOG.md)）——核心邏輯有 60 個離線單元/整合測試（`gh` CLI 以 mock 模擬；HTTP 測試只打 127.0.0.1；不需網路）。完整流程於 2026-07-25 人工驗證（經 built server 走 stdio JSON-RPC 實建 secret gist 的建立/索引/刪除，以及 selfhost 密碼流程端到端——表單 → 錯密碼 401 → 對密碼 200 → 限流 429 → 撤銷 410——並以 `lsof` 確認僅 bind 127.0.0.1），環境：

- macOS（Apple Silicon）、Node v25——gist + selfhost 兩後端

Tunnel 食譜依各工具的標準行為撰寫；Windows／Linux 與真實 tunnel 端到端**尚未驗證**——歡迎回報。

## 授權

MIT © AugustusW
