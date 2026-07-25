# 開發規範

- 後續任務開始前，先讀 `docs/superpowers/specs/2026-07-25-overlay-panel-design.md`；它是目前 UI 規格來源。`docs/specs/2026-07-24-pi-note-panel-design.md` 與 `docs/superpowers/plans/2026-07-24-pi-note-panel.md` 僅作歷史參考。
- 完成修改後至少執行 `npm run check` 與 `git diff --check`。
- 修改 `package.json`、`README.md` 或 `LICENSE` 後，必須執行 `npm pack --dry-run`。
- 不得修改筆記儲存安全邊界或 TUI overlay 契約；若確有必要，必須同步更新目前設計文件，不要求同步更新歷史文件。
