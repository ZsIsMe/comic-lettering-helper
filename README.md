# 漫畫去字工作台 · AutoDL 發行工程

本倉庫提供以項目為單位的漫畫修圖網頁：保存原圖與編輯，生成待修補 Mask，執行三套既有 ComfyUI 工作流，再比較候選並局部合成成品。

**2026-09-12 本機實作狀態：**項目首頁、第一部分編輯畫布、第二部分接入、第三部分比較合成，以及項目封存與刪除已完成本機整合。RF-DETR＋MangaLens 的 CUDA 執行器已實作，但尚未完成目標 GPU 驗收；本次擴充未部署到 AutoDL、未建立新 Tag 或鏡像。既有三工作流的歷史成功記錄不代表新增偵測環境已驗證。

## 使用流程

1. **建立或重開項目。** 每個項目必須包含原圖；可同時上傳同 stem 的 Mask，直接進入第二部分。首頁顯示頁數、更新時間及儲存用量，提供匯入、導出和確認刪除。
2. **準備與編輯。** 可使用「自動檢測」或直接人工編輯；自動檢測先確認，從原圖重跑整個項目並以新結果覆蓋填色、Mask 與人工修改；外部 Mask 僅在新建項目時匯入。畫布提供矩形、畫筆、魔法棒、套索、局部視窗，依目前 Mask 類別進行添加／減去／局部交集；魔法棒另有選區內部、選區＋選區內部、容差／擴展及點擊前預覽。右鍵框選清除兩類 Mask，Cmd／Ctrl＋右鍵互換框內的純色填充與待修補 Mask，清除另有可直接選擇的按鈕，互換僅用快捷手勢。局部副本套用後才回寫；支援縮放、平移、撤銷／重做及保存。可單獨導出底圖＋Mask。
3. **批量修復。** 確認後以不可變快照提交既有引擎，按 Flux2 Klein FP8＋LanPaint、FireRed FP8、Qwen Image Edit 2511＋LanPaint 串行處理，預設只選 Flux。提示詞及已調參數不變。
4. **比較合成。** 從完成的修復任務開啟同步比較，使用筆刷或矩形局部採用候選、整組採用或保留底圖。保存像素來源分配，確認各頁後只導出成品。拖動畫布顯示即時採用預覽；羽化效果以保存後的伺服器預覽及導出為準。

三部分可分開使用：已有 Mask 可跳過偵測；只需模型候選結果可在第二部分下载，不必進入第三部分。第三部分僅接本項目的完成任務，不提供外部候選圖獨立匯入。

「導出項目」保存可續編輯的原圖、修訂、輸入快照、候選及合成記錄，供新網頁工作台重新匯入；「只導出成品」只包含確認後的 PNG。項目保存在伺服器，重新開啟網頁可繼續工作；完整封存不依賴原伺服器路徑，也不承諾桌面 GUI 能直接讀取新版項目格式。

首頁保留「舊版批次與歷史」入口。原有三步提交向導、任務列表、進度及候選 ZIP 下載繼續可用，舊任務不強制轉成項目。

## 預排版功能

預排版已從 `codex/prelayout-web` 合入 `codex/project-workbench`，入口為修圖首頁「預排版」或 `/#/prelayout`。它與圖片修復分別管理圖片、項目、文字進度、常用文字框及輸出，不需要先修圖。介面採連續多頁上下捲動，支持 BT／LabelPlus 匯入、文字移動／旋轉／參考框調整、橫直排、樣式、多選、撤銷／重做及獨立草稿恢復。排版只匯出 `bt.json`，不提供「導出項目」或項目 ZIP 匯出；項目仍保存在伺服器，關閉網頁後可重開續編。

底圖使用分級預覽及可見區圖塊，文字保持獨立渲染；移動／旋轉期間凍結底圖，結束後保存。低解析度只影響預覽，原圖和排版座標保持原有精度。CTD／OCR 的量測結果保存為唯讀版本，匹配需明確套用；沒有角度測量工具或人工編輯 `measure.json` 的入口。獨立倉庫與桌面端打包不在此次範圍。

CTD 流程同時生成來源核心的 `inpainted` 去字預覽：沿用 OpenCV Telea（radius 3、mask expansion 5），把 RGBA 覆蓋層疊回原圖後作為預排版底圖，不必先上傳去字圖。全部頁面驗證完成後才切換底圖；原圖與排版文字保持不變，可隨時切回原圖。這是排版預覽，不调用三套修圖工作流，也不與修圖模組共用圖片。生成的底圖仍使用既有分級預覽及圖塊快取。

**部署狀態：預排版及邊緣塗白已合入本地 `codex/project-workbench`，尚未推送或部署 AutoDL，未建立 Tag 或鏡像；CTD／OCR 真實 CUDA 推理與共享顯存切換仍待目標 GPU 驗收。** 詳見 [實作計劃與範圍](docs/PRELAYOUT_IMPLEMENTATION_PLAN.md)、[本地驗證](docs/PRELAYOUT_LOCAL_VALIDATION.md)及 [部署準備](docs/DEPLOYMENT.md#預排版部署準備)。

勾選「原圖對照」後，左側為預排版編輯圖，右側為原圖。勾選「偵測框」同時顯示文字區塊與單字框；滑鼠停在單字框上會顯示如 `W12H12FS22.0` 的提示，W／H 為原圖像素寬高，FS 優先使用估算字級。沿用原程式的 OCR／字級篩選結果；既有偵測資料可直接顯示，無須重新推理。

「上傳去字圖」入口目前隱藏，介面使用生成的 `inpainted` 預覽；底層去字圖匯入功能與既有資產保留。

### 預排版快捷鍵

先點選文字；Shift 點選可多選。Mac 使用 ⌘／Option，Windows 使用 Ctrl／Alt。

| 操作 | 快捷鍵 | 大步調整 |
| --- | --- | --- |
| 移動 | 方向鍵：1 原圖像素 | Shift：10；⌘／Ctrl＋Shift：50 |
| 放大／縮小文字 | ⌘／Ctrl＋＋／－：增減 2（＋也可按 =） | 再加 Option／Alt：增減 10 |
| 逆時針／順時針旋轉 | ⌘／Ctrl＋[／]：1° | 再加 Option／Alt：5° |

選中文字後，選框四角顯示 ↶／↷ 旋轉按鈕：左側逆時針、右側順時針，每次 1°，Option／Alt 點擊為 5°；多選時套用所有選取文字。按鈕跟隨選框並保持固定螢幕大小，上方圓點仍可拖曳旋轉。

Option／Alt＋滾輪也可增減字級 2；普通滾輪上下捲動，⌘／Ctrl＋滾輪縮放畫面。多選時逐條增減，保留各自的字級與角度差；同一快捷鍵長按連續調整可一次撤銷，放開再按另記一步。輸入框、中文組字、彈窗及拖曳期間不觸發文字快捷鍵。PageUp／PageDown 切換頁面，Q 切換去字底圖；完整操作表在網頁頂部「快捷鍵」。

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

新建項目在圖片匯入區下方提供「自動檢測設定」：Mask 膨脹尺寸、塗白範圍、氣泡辨識與氣泡內縮。建立時只保存設定，不啟動模型；進入項目後，自動檢測在同一視窗調整設定並確認覆蓋範圍。設定隨項目保存及封存，重新開啟時沿用。

新建項目的原圖及可選 Mask 採單一匯入區：拖入圖片或單個資料夾，或點擊選擇多張圖片／單個資料夾，與「去四邊」頁相同。資料夾選取使用標準瀏覽器輸入，瀏覽器可能枚舉子目錄，但前端只保留第一層圖片，不上傳子目錄檔案；拖入資料夾則僅枚舉第一層。新建後不再提供外部 Mask 匯入；第一部分顯示「自動檢測」與中文進度，模型及裝置資訊留在維護配置和日誌。

第一部分左側恢復「Mask / 原圖」混合滑桿，右側顯示即時填色及可調的待修補標記；修改、擦除與撤銷同步更新雙側，不必等保存。偵測可明確選擇 CUDA、Apple MPS 或 CPU；本機使用已有權重和獨立 Python 環境，詳見 [模型設定](docs/DETECTION_MODELS.md)。

- 原圖接受 PNG／JPG／JPEG，Mask 接受 PNG；文件夾僅匯入第一層，忽略 `._*`，重新選擇整批取代，按 stem 配對並拒絕重名、缺頁和尺寸不符。
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

項目刪除會顯示確認視窗，列出名稱及刪除範圍；成功後立即移除列表卡片，失敗原因保留在視窗內供重試。

編輯工具、局部視窗與本機驗證記錄見 [編輯工具說明](docs/EDITOR_TOOLS.md)。

F1 純色填充與 F2 待修補以常駐按鈕切換，記住上次選擇。工具列依編輯／工具／操作分排，保存及縮放獨立排列；Cmd／Ctrl＋右鍵拖框互換框內的純色填充與待修補 Mask，不受 F1／F2 影響；空白與框外不變。

自動分類採氣泡內局部取樣、氣泡外近 3 px／延伸 12 px 四向檢查，避免白色描邊誤判；氣泡填色擴展失敗不更改原分類。Cmd／Ctrl＋右鍵互換時，純色轉待修補只保留文字＋3 px 邊距及人工添加範圍，撤掉框內其餘氣泡擴展填色；缺少有效文字偵測資料時維持原範圍互換。
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
