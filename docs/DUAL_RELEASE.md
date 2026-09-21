# GitHub / Gitee 雙平台更新與發布

固定可信倉庫為 GitHub 與 Gitee 上的 `ZsIsMe/comic-lettering-helper`。Git 匯入不會同步 Release 附件，因此每個正式版本必須把同一份 `application.zip` 和 `application.zip.sha256` 發到兩邊。`0.2.10` 已完成雙發布。

應用檢查更新時優先讀取 Gitee 正式 Release；Gitee 不可用、不是純數字語義版本，或缺少任一必要附件時才查 GitHub。Tag 本身不算可安裝版本。安裝時會重新解析使用者要求的精確較新版本，而不受畫面版本清單只顯示最新版的限制。

ZIP 與 SHA-256 必須來自同一個 Release 來源，不能跨站拼接。Gitee metadata 完整但附件發生 timeout、HTTP 或連線讀取錯誤時，安裝器才會從 GitHub 重新下載整套 SHA-256 與 ZIP。若已成功取得 Gitee SHA-256，GitHub 的 SHA-256 必須完全相同；兩平台不一致會明確拒絕。checksum 格式錯誤或 ZIP hash 不符屬於完整性失敗，不會以切換來源掩蓋。所有 API、附件和壓縮檔讀取都有逾時、大小、數量及路徑限制。

## 更新包與鏡像契約

新版更新包的 manifest format 為 2，除 `backend/app/`、`backend/imaging/`、`backend/prelayout_core/` 與 `frontend/dist/` 外，會攜帶 `runtime-tools/`、`workflows/`，以及以下三個精確設定檔：

- `config/runtime.json`
- `config/components.json`
- `config/models.json`

其他 `config/` 路徑（尤其 `.env`）一律拒絕。資料、模型權重、Python 環境和 app root 的 `runtime-capabilities.json` 不在更新包內，也不會被覆寫。

目前新包固定要求 runtime contract `qwen21-native-int8-v1`。新 Qwen 2.1 native、ComfyUI 0.37、torch 2.14 鏡像必須由鏡像製作流程在 app root 建立：

```json
{
  "format": 1,
  "capabilities": ["qwen21-native-int8-v1"]
}
```

安裝器會先比對此標記和既有 Python requirements 雜湊，再變更任何檔案。不相容的舊鏡像會拒絕安裝並提示先更換鏡像；不會自動下載模型、升級 ComfyUI／torch 或修改環境。舊版 updater 也會因不認得 manifest format 2 及新增路徑而安全拒絕新包。因此從舊鏡像第一次切換 Qwen 2.1 必須先使用相容新鏡像，之後才能走網頁更新。

安裝前逐檔校驗，安裝時備份所有將覆寫的現有檔案；6008 重啟或健康檢查失敗時，同一 inventory 會回復舊檔並重新啟動舊版本。使用者資料與模型不在 inventory 中。

## 發布

`deploy/build-update.py` 只允許版本、`config/runtime.json`、HEAD Tag 及乾淨工作樹一致時產生包。`deploy/publish-release.py` 預設只做 plan；只有顯式加 `--apply` 才會發布。腳本不重新打包第二份附件、不覆寫內容不同的既有附件，並在發布後以無憑證公開下載逐位元組驗證。

```sh
python3 deploy/build-update.py /tmp/comic-release-X.Y.Z
python3 deploy/publish-release.py X.Y.Z /tmp/comic-release-X.Y.Z \
  --notes-file /tmp/release-notes.md --title X.Y.Z
# 確認 plan 後才由發布者執行：
python3 deploy/publish-release.py X.Y.Z /tmp/comic-release-X.Y.Z \
  --notes-file /tmp/release-notes.md --title X.Y.Z --apply
```

GitHub 使用既有 `gh auth login`。Gitee token 只從執行環境的 `GITEE_TOKEN` 或 macOS 登入鑰匙圈服務 `codex-gitee-token` 讀取，不接受命令列 token，也不寫入 Git 或日誌。兩邊 Tag 必須先指向 manifest 的同一 commit。可用 `--platform github` 或 `--platform gitee` 單獨重試未完成的一邊。

0.2.11 依使用者授權建立 commit、Tag 並發布雙平台 Release；本地與無卡環境檢查已完成，GPU 回歸由使用者開機測試。
