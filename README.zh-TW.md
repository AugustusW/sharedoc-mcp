# sharedoc-mcp

**把 agent 產出的 Markdown 變成分享連結。**一個 MCP server，讓「這份報告給你」從貼一大段文字變成一條 URL——後端可選 GitHub gist（零設定）或自己的機器（密碼、期限、完全掌控）。

[English](./README.md) | [繁體中文](./README.zh-TW.md)

**版本 1.0.0** · [CHANGELOG](./CHANGELOG.md) · MIT

## 為什麼

AI agent 整天在產 Markdown——報告、研究摘要、會議記錄。要交給另一個人，通常得把整面文字牆貼進聊天視窗。sharedoc-mcp 給你的 agent 8 個工具：發佈、更新、搜尋、撤銷分享文件，讓「傳給我同事」變成一條連結。

## 兩個後端，同一組介面

| | 🅰 `gist`（預設） | 🅱 `selfhost` |
|---|---|---|
| 設定 | 無——用你已登入的 `gh` CLI | 無額外設定——資料留在你機器上 |
| 文件放在 | GitHub（secret gist） | 你的機器（SQLite） |
| 連結可達性 | 任何地方、立即 | localhost——要對外分享請接 tunnel |
| 密碼 | ✗（secret URL 本身就是保護） | ✓ server 端驗證（bcrypt）+ 錯誤嘗試限流 |
| 期限 | 惰性——過期 gist 於下次使用時刪除 | 強制——過期連結回 410 |
| 撤銷 | gist 立即刪除、不可逆 | 立即 410，內容 7 天緩衝期後清除 |
| 檔案分享 | ✗（gist 僅文字） | ✓（檔案無密碼/期限——連結是唯一保護） |

8 個 MCP 工具兩邊完全相同；後端不支援某參數時（如 gist 收到 `password`）會回明確錯誤，不會靜默忽略。

## 安裝

需要 Node.js ≥ 22.13.0。gist 後端另需已登入的 [GitHub CLI](https://cli.github.com)（`gh auth login`）。

**Claude Code：**

```bash
claude mcp add sharedoc --scope user -- npx -y sharedoc-mcp
```

**Codex CLI**（`~/.codex/config.toml`）：

```toml
[mcp_servers.sharedoc]
command = "npx"
args = ["-y", "sharedoc-mcp"]
```

其他 MCP client：以 stdio server 方式執行 `npx -y sharedoc-mcp`。

## 快速開始（gist 後端）

跟你的 agent 說「把這個做成分享文件」——它會呼叫 `create_shared_doc` 回傳一條 secret gist URL。Secret gist 不會被公開列出、網址無法猜測，但**拿到連結的任何人都能讀**——這就是此後端的完整安全模型；需要密碼請改用 `selfhost`。

本地索引（`~/.config/sharedoc-mcp/index.json`）記錄你分享過的內容，供 `search_shared_docs` 與過期清理使用。此後端的期限是*惰性*的：過期 gist 在下次任一工具執行時才被刪除，不是在到期那一刻。

## Selfhost 後端

```bash
claude mcp add sharedoc --scope user --env SHAREDOC_BACKEND=selfhost -- npx -y sharedoc-mcp
```

文件存在 `~/.local/share/sharedoc-mcp/` 的 SQLite；viewer 於 `http://127.0.0.1:8377` 服務。Server **永遠只 bind 127.0.0.1**——對外曝光刻意交給你自己控制的 tunnel：

| 食譜 | 適合 | 設定 |
|---|---|---|
| **Tailscale Funnel**（推薦） | 沒網域、要固定網址 | 裝 [Tailscale](https://tailscale.com) 後 `tailscale funnel 8377` → 固定 `https://<機器>.<tailnet>.ts.net`；把 `SHAREDOC_PUBLIC_URL` 設成它 |
| **Cloudflare named tunnel** | 有自己的網域 | 網域掛進 Cloudflare，`cloudflared tunnel create` + 把主機名 route 到 `http://127.0.0.1:8377`；設 `SHAREDOC_PUBLIC_URL` |
| **cloudflared quick tunnel** | 臨時分享 | `cloudflared tunnel --url http://127.0.0.1:8377` → 隨機 `trycloudflare.com` 網址，每次重啟會變；當次設 `SHAREDOC_PUBLIC_URL` |

環境變數：

| 變數 | 預設 | 意義 |
|---|---|---|
| `SHAREDOC_BACKEND` | `gist` | `gist` 或 `selfhost` |
| `SHAREDOC_PORT` | `8377` | viewer 埠（selfhost） |
| `SHAREDOC_PUBLIC_URL` | `http://127.0.0.1:<port>` | 分享連結的網址前綴——設成你的 tunnel 主機名 |
| `SHAREDOC_DATA_DIR` | `~/.local/share/sharedoc-mcp` | SQLite 與檔案位置（selfhost） |
| `SHAREDOC_INDEX_PATH` | `~/.config/sharedoc-mcp/index.json` | 本地索引（gist） |
| `MCP_CALLER` | — | 建立文件的預設作者歸因 |

### 安全語意（誠實版）

- 密碼以 bcrypt 雜湊、server 端驗證通過才吐內容；錯誤嘗試限流（每來源+文件 5 次/分鐘，HTTP 429）。**經 tunnel 時所有外部訪客共用同一個來源位址**，實際效果是每份文件 5 次/分鐘——比逐訪客更嚴格，但一個人打錯幾次密碼會讓該文件對其他人短暫鎖定。
- 文件內容經 `marked` 渲染並以 `sanitize-html` 消毒——分享內容中的 script、事件屬性、`javascript:` 連結都會被剝除。
- 分享的**檔案**沒有密碼與期限：無法猜測的連結是唯一且永久的保護，下載也不限流。
- 兩個 MCP client 可指向同一個資料目錄：SQLite 走 WAL 模式 + busy timeout；若 viewer 埠已被另一個 sharedoc-mcp 佔用，第二個 client 保留工具功能、共用既有 viewer。

## 8 個工具

| 工具 | 功能 |
|---|---|
| `create_shared_doc` | 標題 + Markdown（+ 選填密碼 / `expires_in_hours` / 作者）→ 分享 URL。5 分鐘內完全相同的無保護重試回同一 URL；補加密碼或期限的重試一律建新文件 |
| `create_shared_file` | 分享本機檔案（僅 selfhost） |
| `append_to_shared_doc` | 在既有文件尾端追加 Markdown（非冪等——重試會加兩次） |
| `extend_shared_doc` | 延長期限 N 小時 |
| `reset_shared_doc_password` | 設定／更換／移除（null）密碼（僅 selfhost） |
| `update_shared_doc_title` | 改標題 |
| `revoke_shared_doc` | 撤銷連結（語意見後端對照表） |
| `search_shared_docs` | 標題子字串 + 狀態篩選 |

## 開發

```bash
git clone https://github.com/AugustusW/sharedoc-mcp.git
cd sharedoc-mcp
npm install
npm test        # 先 build 再跑 52 個離線測試——gh CLI 以 mock 替身，HTTP 測試只打 127.0.0.1
```

版本規則：每次釋出 bump `package.json` 的 `version`、加一筆 [CHANGELOG](./CHANGELOG.md)、打 git tag 發 GitHub Release + npm。你的索引、文件 DB、檔案都在套件外——更新永遠不會動到它們。

## 授權

MIT © AugustusW
