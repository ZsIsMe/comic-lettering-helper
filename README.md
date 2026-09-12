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

## 預排版功能

預排版已在 `codex/prelayout-web` 工作樹完成本地功能整合，入口為「開啟預排版」或 `/#/prelayout`。它與圖片修復分別管理圖片、項目、文字進度、常用文字框及輸出，不需要先修圖。介面採連續多頁上下捲動，支持 BT／LabelPlus 匯入、文字移動／旋轉／參考框調整、橫直排、樣式、多選、撤銷／重做及獨立草稿恢復。排版只匯出 `bt.json`，不提供「導出項目」或項目 ZIP 匯出；項目仍保存在伺服器，關閉網頁後可重開續編。

底圖使用分級預覽及可見區圖塊，文字保持獨立渲染；移動／旋轉期間凍結底圖，結束後保存。低解析度只影響預覽，原圖和排版座標保持原有精度。CTD／OCR 只生成唯讀量測版本，匹配需明確套用；沒有角度測量工具或人工編輯 `measure.json` 的入口。獨立倉庫與桌面端打包不在此次範圍。

**部署狀態：程式記錄於 `codex/prelayout-web` 本地分支，尚未推送、合併回原分支或部署，未建立 Tag 或鏡像；CTD／OCR 真實 CUDA 推理與共享顯存切換仍待目標 GPU 驗收。** 詳見 [實作計劃與範圍](docs/PRELAYOUT_IMPLEMENTATION_PLAN.md)、[本地驗證](docs/PRELAYOUT_LOCAL_VALIDATION.md)及 [部署準備](docs/DEPLOYMENT.md#預排版部署準備)。

### 預排版模型與配套資產

權重、模型快取、字型與推理環境不加入工程或 Git。製作鏡像時，把下列五項資產直接放到工程外的 `/root/models/comic-prelayout/`，或透過 `COMIC_PRELAYOUT_MODEL_ROOT` 指定另一外部目錄。此表中的來源相對路徑均相對於使用者提供的 `/Users/zhongsheng/Projects/comic-text-detector`；維護者可從該工程已有資產準備鏡像，應用不自動下載。

| 鏡像內檔名 | 已有來源相對路徑 | SHA-256（已讀取本機檔案核對） |
| --- | --- | --- |
| `comictextdetector.pt` | `data/comictextdetector.pt` | `1f90fa60aeeb1eb82e2ac1167a66bf139a8a61b8780acd351ead55268540cccb` |
| `mit48pxctc_ocr.ckpt` | `data/models/mit48pxctc_ocr.ckpt` | `8b0837a24da5fde96c23ca47bb7abd590cd5b185c307e348c6e0b7238178ed89` |
| `alphabet-all-v5.txt` | `data/alphabet-all-v5.txt` | `c1295ae1962e69e35b5b225a0405d1f3432e368c9941d23bfd3acda12654da33` |
| `NotoSansCJKjp-Medium.otf` | `assets/fonts/NotoSansCJKjp-Medium.otf` | `dd523e580e3413c480b2d701bf64e534c20f8419e3cfb6a44c2bdcd8d2a6c052` |
| `NotoSansCJKjp-Medium.ink-metrics.json` | `assets/fonts/NotoSansCJKjp-Medium.ink-metrics.json` | `29a0af82d3501eab9bf8bb0f8de8294b972927eb7d6e863b7cfd2d165ce28a56` |

CTD 單字框方法需要 CTD 權重；OCR 對齊字級方法需要全部五項。網頁預覽使用同一固定字型，透過同源 `/api/prelayout/font` 載入並帶版本快取鍵。缺少字型時提示系統替代字型，人工編輯仍可用；不同系統的替代字型外觀不保證一致。缺少模型時僅停用對應偵測方法，不自動切換演算法或 CPU 推理。

`backend/requirements-prelayout.txt` 記錄已驗證可載入核心的本機依賴版本。參考環境為 Python 3.14.6、PyTorch 2.13.0、torchvision 0.28.0、macOS arm64；這不是 Linux CUDA 鎖定環境。鏡像須另建外部 Python 環境，選定相容的 PyTorch／torchvision CUDA wheels，完成下列預檢及真實 GPU 測試後，保存最終依賴清單。不要把新依賴裝進 ComfyUI 的 Python。

```bash
# 設定寫入目標鏡像的 .env；推理環境、模型均在原始碼目錄外。
COMIC_PRELAYOUT_DATA_ROOT=/root/autodl-tmp/comic-inpaint/prelayout
COMIC_PRELAYOUT_MODEL_ROOT=/root/models/comic-prelayout
COMIC_PRELAYOUT_PYTHON=/root/comic-prelayout-venv/bin/python
COMIC_PRELAYOUT_DEVICE=cuda

# 從 /root/comic-inpaint 執行；需要先準備好上面的外部環境及五項資產。
PYTHONPATH=backend /root/comic-prelayout-venv/bin/python -m prelayout_core.check \
  --model-root /root/models/comic-prelayout --method ocr_aligned --require-cuda
```

本地測試可直接使用已有模型及隔離 Python，不必先放入鏡像。Apple Silicon 可明確設定 `COMIC_PRELAYOUT_DEVICE=mps`，並用 `prelayout_core.check --device mps` 預檢；預設仍為 `cuda`。設備由服務端設定並記入任務，不能由網頁請求改成 CPU。MPS 任務不依賴 CUDA 的 ComfyUI 服務，但仍取得共用 GPU gate，且強制 `PYTORCH_ENABLE_MPS_FALLBACK=0`；設備不可用時明確失敗。本地模型測試使用使用者指定資料夾的副本建立獨立預排版項目，原圖及譯稿保持不變。

預檢只校驗資產、依賴、字型指標與指定 GPU 的可見性，不執行模型推理，回報的 `inference_verified` 固定為 `false`。`GET /api/prelayout/availability` 只檢查基本檔案及環境路徑，不能代替預檢。鏡像還須安裝 `ps`（Linux 通常由 `procps` 提供），供程序群組恢復與安全取消使用。

來源核心固定於 commit `ffa7b7e2c3ea87c191d2483d736d0e1975179782`，保留 [來源與授權說明](backend/prelayout_core/NOTICE.md)。核心不依賴來源工程的本機路徑、Qt 或 QtWebEngine。

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
