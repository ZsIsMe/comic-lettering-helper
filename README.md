# 漫畫去字工作台 · AutoDL 發行工程

本倉庫提供以項目為單位的漫畫修圖網頁：保存原圖與編輯，生成待修補 Mask，執行三套既有 ComfyUI 工作流，再比較候選並局部合成成品。

**2026-09-12 本機實作狀態：**項目首頁、第一部分編輯畫布、第二部分接入、第三部分比較合成，以及項目封存與刪除已完成本機整合。RF-DETR＋MangaLens 的 CUDA 執行器已實作，但尚未完成目標 GPU 驗收；本次擴充未部署到 AutoDL、未建立新 Tag 或鏡像。既有三工作流的歷史成功記錄不代表新增偵測環境已驗證。

## 使用流程

1. **建立或重開項目。** 每個項目必須包含原圖；可同時上傳同 stem 的 Mask，直接進入第二部分。首頁顯示頁數、更新時間及儲存用量，提供匯入、導出和確認刪除。
2. **準備與編輯。** 可使用 RF＋MangaLens 偵測，或直接人工編輯／匯入 Mask。畫布提供縮放、平移、筆刷、矩形、純色填充、待修補區域、擦除、撤銷／重做及保存。可單獨導出底圖＋Mask。
3. **批量修復。** 確認後以不可變快照提交既有引擎，按 Flux2 Klein FP8＋LanPaint、FireRed FP8、Qwen Image Edit 2511＋LanPaint 串行處理，預設只選 Flux。提示詞及已調參數不變。
4. **比較合成。** 從完成的修復任務開啟同步比較，使用筆刷或矩形局部採用候選、整組採用或保留底圖。保存像素來源分配，確認各頁後只導出成品。拖動畫布顯示即時採用預覽；羽化效果以保存後的伺服器預覽及導出為準。

三部分可分開使用：已有 Mask 可跳過偵測；只需模型候選結果可在第二部分下载，不必進入第三部分。第三部分僅接本項目的完成任務，不提供外部候選圖獨立匯入。

「導出項目」保存可續編輯的原圖、修訂、輸入快照、候選及合成記錄，供新網頁工作台重新匯入；「只導出成品」只包含確認後的 PNG。項目保存在伺服器，重新開啟網頁可繼續工作；完整封存不依賴原伺服器路徑，也不承諾桌面 GUI 能直接讀取新版項目格式。

首頁保留「舊版批次與歷史」入口。原有三步提交向導、任務列表、進度及候選 ZIP 下載繼續可用，舊任務不強制轉成項目。

## 輸入與 GPU 規則

- 原圖接受 PNG／JPG／JPEG，Mask 接受 PNG；文件夾只讀第一層，忽略 `._*`，重新選擇整批取代，按 stem 配對並拒絕重名、缺頁和尺寸不符。
- 待修補 Mask 灰階值大於等於 128 為白色修補區。缺少 Mask 不等於全黑 Mask。Qwen 所需 RGBA 由既有批次器構造。
- 全黑頁沿用**當次底圖**，仍保留完整輸出集合。整批全黑不等待 ComfyUI、不載入修復模型，也不產生無內容的比較 PDF。
- 偵測與修復共用單一 GPU 保留鎖；忙碌時拒絕新提交。RF、MangaLens 及三套修復模型均不並行常駐。
- 模型缺失只禁用第一部分偵測，不影響匯入 Mask、人工編輯或第二部分。普通編輯與合成不觸發模型。

AutoDL `WebUI-6006` 保留原生 ComfyUI；`WebUI-6008` 提供工作台。後端僅以 `http://127.0.0.1:6006` 連接 ComfyUI。

`workflows/` 與 `runtime-tools/` 沿用 2026-09-09 在 AutoDL `pro-788873e1ad26`、RTX 4080 SUPER 32 GB 上完成三流程實測的版本。硬體、耗時及顯存數字僅適用於該歷史基線。

## 技術與本機開發

React＋TypeScript＋Vite＋Ant Design 提供頁面，Canvas 提供原尺寸像素編輯。FastAPI、Pillow、NumPy／OpenCV 管理資料及 CPU 影像處理；項目索引與任務記錄使用磁碟 JSON，沒有另建資料庫。RF／MangaLens 使用可選、獨立的 Python CUDA 環境，ComfyUI 環境保持分離。

```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

在倉庫根目錄的另一個終端啟動後端：

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
COMIC_APP_ROOT="$PWD" COMIC_DATA_ROOT="$PWD/var" \
  .venv/bin/uvicorn app.main:app --app-dir backend --reload --port 6008
```

一般 Web 開發不需要安裝偵測模型依賴。檢查命令：

```bash
npm --prefix frontend run lint
npm --prefix frontend run build
.venv/bin/python -m pytest -q backend/tests
make verify-local
```

`verify-local` 另需要所指定 `COMFY_ROOT` 中有 ComfyUI、節點及模型；開發機缺少這些資源時，不得把靜態檢查失敗或跳過說成 GPU 驗收成功。

- [系統架構與資料契約](docs/ARCHITECTURE.md)
- [部署與從零重建](docs/DEPLOYMENT.md)
- [版本及鏡像發布](docs/RELEASE.md)
- [RF／MangaLens 模型、隔離依賴與待驗收事項](docs/DETECTION_MODELS.md)
- [需求、里程碑及完整工作台計劃](docs/PROJECT_WORKBENCH_PLAN.md)（需求基線；實際完成狀態以本文件與當次驗證報告為準）

## 邊緣塗白（獨立頁面）

首頁的「邊緣塗白」入口開啟 `#/edgewhite`，可單獨建立圖片集合，不需要 Mask、模型或 ComfyUI。資料保存在 `<COMIC_DATA_ROOT>/edgewhite/`，與修復項目及其他工具分開。

- **資料夾只讀第一層，絕不進入子資料夾。** 使用「選擇圖片文件夾（只讀第一層）」或把資料夾拖入建立視窗；程式只枚舉根目錄，不使用會遞歸展開的 `webkitdirectory`。不支援目錄選取 API 的瀏覽器提供拖入資料夾或多選圖片。每次選擇整批取代，忽略隱藏檔及 `edgewhite_guides.json`。
- 接受 PNG／JPG／JPEG；同 stem 不可重複。保留原件，建立同尺寸 sRGB PNG 工作圖；透明處使用白底。含 EXIF 旋轉方向時先提示整理，單圖上限 4000 萬像素。
- 左側從四邊標尺拖出多條線；選中線後，用醒目的方向按鈕或 Option／Alt＋方向鍵，在指定方向 64 px 內找完整空白分段最多的位置，同分取最近，不跨越相鄰線。容差預設 30；普通箭頭微調 1 px，提供一次吸附撤銷。
- 點選網格塗白，右側即時預覽。新增／刪除線清空選區，移動線保留選區；四個絕對座標快捷線及容差由目前瀏覽器記住。
- 線位和選區自動保存草稿；「保存圖片／保存並下一頁」更新正式輸出。下載前需逐頁保存待更新輸出。ZIP 含完整 `deal/<stem>.png`，未編輯頁也保留。
- 搬入 Mac 既有編輯時，先建立集合並匯入**原圖**，再匯入原資料夾的 `edgewhite_guides.json`。按完整原檔名匹配，不使用 `deal` 代替原圖。線位 JSON 可單獨導出；完整集合 ZIP 重新匯入暫不提供。

本機開發版本尚未部署到 AutoDL。吸附演算法與瀏覽器合成樣本檢查見 [邊緣塗白本機驗證](docs/EDGEWHITE_LOCAL_VALIDATION.md)；使用者仍需逐頁確認實際漫畫的有效內容邊界。


### 2026-09-12 匯入入口修訂（取代此前非遞歸選取器方案）

使用者已允許瀏覽器掃描子目錄。新建集合改為單一匯入區：點擊唯一匯入區後，在選單選擇「多張圖片」或「單個資料夾」，也可直接拖入；資料夾模式使用標準 `input webkitdirectory`，不再呼叫 `showDirectoryPicker`。瀏覽器可列舉子目錄，應用只匯入第一層圖片，避免包含 deal 成品。因瀏覽器原生檔案選擇器區分圖片多選及目錄模式，兩種模式由同一入口的選單選取，不再有獨立資料夾按鈕。

內建瀏覽器實測：經資料夾選擇器指定第 82 話目錄，顯示 21 張並略過 1 個子資料夾；點擊主區開啟多選選擇器，選入 2 張測試圖片成功。此前 showDirectoryPicker 的阻塞不再適用於新版入口。lint、build、18 項前端及 61 項後端測試通過。
