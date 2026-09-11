# 漫畫去字工作台 · AutoDL 發行工程

這個倉庫把已驗證的三套 ComfyUI 漫畫修復流程封裝成 AutoDL 啟動即用的批量 Web 應用：

- Flux2 Klein FP8 + LanPaint
- FireRed FP8
- Qwen Image Edit 2511 + LanPaint

普通使用者只需要開機、打開 6008 服務頁面，再依照三步向導放入原圖與黑白 Mask、選擇修復流程並命名任務。原圖與 Mask 都可選擇整個文件夾或一次多選圖片；後端負責配對、輸入驗證、Qwen RGBA 轉換、串行推理、進度、結果整理與下載。

網站預設只選 Flux2 Klein；重新選擇會整批取代上一次選擇，文件夾模式只讀取第一層圖片。任務提交時自動在名稱後追加 `_月日_時分秒`，例如 `第89話_0911_221530`。任務記錄、完成結果和下載包持久保存在服務器，刷新頁面後仍可恢復進度與下載。

AutoDL 端口固定為：`WebUI-6006` 保留原生 ComfyUI，`WebUI-6008` 提供本專案的批量網站。

這裡的工作流 JSON 與 `runtime-tools/` 不是示例：它們就是 2026-09-09 在 AutoDL `pro-788873e1ad26`、RTX 4080 SUPER 32 GB 上完成三流程實測的版本。Web 層只負責封裝，不會重寫提示詞或推理參數。

## 技術棧

- Frontend：React、TypeScript、Vite、Ant Design 5
- Backend：FastAPI、Pillow、單 GPU FIFO 任務隊列
- Engine：ComfyUI API + 既有三工作流批次器
- Deployment：AutoDL 實例鏡像，不使用 Docker-in-Docker

## 開發

```bash
cd frontend
npm install
npm run dev
```

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
COMIC_APP_ROOT="$PWD" COMIC_DATA_ROOT="$PWD/var" \
  .venv/bin/uvicorn app.main:app --app-dir backend --reload --port 6008
```

部署與從零重建記錄見 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

系統邊界、輸入契約、任務生命週期與顯存基線見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

Git Tag、遠端測試與 AutoDL 鏡像的版本關係見 [docs/RELEASE.md](docs/RELEASE.md)。
