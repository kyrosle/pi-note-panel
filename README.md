# Pi Note Panel

Pi coding agent 的專案級 Markdown 筆記 overlay。筆記會留在右側、覆蓋其下方的 terminal cells，**不會改變** conversation 或 editor 的寬度，也不會自動加入模型 context；agent 只有呼叫讀取工具時才會取得筆記內容。

```text
+---------------- Pi terminal ----------------+
| Conversation and editor                     |
|                              +-------------+|
|                              | Project     ||
|                              | Notes       ||
+------------------------------+-------------+
```

Panel 預設關閉。啟用後使用專案設定的寬度與高度顯示；終端不足 20 欄 × 8 列時會暫時隱藏，空間恢復時自動重新顯示，且不會改寫已儲存的設定。

## 安裝 / Install

```bash
pi install npm:pi-note-panel
```

在 npm 尚未發布前，從 GitHub 安裝：

```bash
pi install git:github.com/kyrosle/pi-note-panel
```

## 專案資料 / Project data

每個 Pi working directory 都是獨立專案，資料不會跨專案共用：

- `.pi/NOTE.md`：筆記內容；只在首次寫入或 `/note-panel edit` 時 lazy 建立。
- `.pi/note-panel.json`：專案級顯示偏好，格式為 `{ "enabled": false, "width": 36, "height": 20 }`。

讀取不會建立 `.pi`。只有 `on`、`off`、`width`、`height` 或 `size` 等顯示設定指令會以 atomic write 持久化偏好。舊的合法設定若缺 `height`，讀取時會使用 `20`，但不會立即改寫檔案。

## 指令 / Commands

```text
/note-panel
/note-panel on
/note-panel off
/note-panel width <20-160>
/note-panel height <8-120>
/note-panel size <20-160> <8-120>
/note-panel refresh
/note-panel edit
/note-panel focus
```

無參數會顯示啟用狀態、configured size、目前 rendered size 與可見原因。`size` 會一次寫入寬高。無效值或額外參數不會修改設定。`focus` 在 panel disabled、terminal 太小、或 UI 不可用時會說明原因。

焦點在 panel 時：`Up`/`Down` 逐行捲動、`PageUp`/`PageDown` 捲動一個內容視窗、`Home`/`End` 跳到開頭/結尾、`Esc` 回到進入 overlay 前的 Pi 焦點。

## Agent tools

五個 tools 都只針對目前專案的筆記：

| Tool | 參數 | 結果 |
| --- | --- | --- |
| `note_panel_info` | 無 | 不回傳筆記正文，回傳目前 layout 與筆記容量 metrics。 |
| `note_panel_read` | 無 | 回傳已移除 terminal controls 的筆記 Markdown 與 metrics。 |
| `note_panel_append` | `{ content: string }` | 附加 Markdown 並回傳寫入後 metrics。 |
| `note_panel_replace` | `{ content: string }` | 完整取代筆記並回傳 metrics。 |
| `note_panel_update_section` | `{ heading, content, mode, level? }` | 以 exact、case-insensitive ATX heading 更新區段並回傳 metrics。 |

每個 metrics 物件包含：

- `uiAvailable`、`visible`、`hiddenReason` 與 `terminal`：實際 UI、可見狀態和終端尺寸。
- `panel.configuredWidth`、`configuredHeight`：持久化的原始設定。
- `panel.outerWidth`、`outerHeight`：TUI 中經 terminal clamp 後的 overlay 尺寸；print、JSON 與 RPC 模式為 `null`。
- `panel.contentWidth`、`contentRows`、`scrollOffset` 與 wrapped-line metrics：內容容量與捲動位置。Panel disabled 時仍計算容量，但 `visibleWrappedLines` 為零。

## 安全與內容邊界

- 筆記是 plain Markdown，不是 terminal instructions；渲染與 `note_panel_read` 都會剝除 terminal control sequences。
- 每次寫入後筆記上限為 256 KiB，且只接受 UTF-8 文字。
- 讀寫會拒絕 `.pi` 或 `NOTE.md` 經 symlink 逃出目前專案的情況。
- 寫入使用 `.pi` 內暫存檔加 atomic rename；驗證失敗不會覆寫既有資料。

## 相容性 / Compatibility

Pi >=0.82 且 <1.0 的原生 `TUI.showOverlay()` 負責 overlay stack 與焦點還原；其他 overlay 不會造成根 layout 衝突。headless、print、JSON 與 RPC 模式不安裝視覺 overlay，但 commands 與 tools 仍可用；RPC 若有 dialog UI，`/note-panel edit` 仍可使用。

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE) © 2026 kyrosle. Repository: [kyrosle/pi-note-panel](https://github.com/kyrosle/pi-note-panel).
