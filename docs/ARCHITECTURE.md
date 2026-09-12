# 系統架構

本專案以項目串接「準備與編輯 → 批量修復 → 比較合成」。第二部分沿用既有 ComfyUI 引擎、批次器與三份固定工作流；第一部分新增獨立 RF-DETR／MangaLens 推理程序，第三部分是 CPU／Canvas 像素合成。

2026-09-12：上述工作台功能已在本機實作整合；新增 CUDA 環境與模型切換尚待目標 GPU 驗收，本次擴充未部署、未建立新 Tag 或鏡像。本文後段保留原第二部分的輸入、任務及性能記錄，只有明確標示的歷史基線已做過遠端 GPU 實測。需求邊界見 [工作台計劃](PROJECT_WORKBENCH_PLAN.md)，偵測部署限制見 [偵測模型說明](DETECTION_MODELS.md)。

## 獨立資料的網頁預排版

頁碼導覽位於頂部工具列下方，橫向排列並自動換行，不佔左側欄位；頁數較多時導覽區最高佔視窗 25%，其餘頁碼可在區內捲動。既有點頁跳轉、目前頁高亮、連續捲動與顯示切換邏輯保留。

預排版工具列目前隱藏「上傳去字圖」，保留 BT／LabelPlus 入口。既有 `clean` 匯入處理及 API 保留；底圖仍直接使用已生成的 inpainted 預覽。

`WorkspaceEntry.tsx` 在原工作台旁加入預排版入口，前端按需載入；切換前保存目前操作，修圖工作台保留自己的編輯狀態。預排版離開時卸載自身鍵盤事件，CSS 使用 `pl-` 範圍。預排版沒有獨立 Git 倉庫或桌面殼。

```text
/api/prelayout → PrelayoutStore → <COMIC_PRELAYOUT_DATA_ROOT>
                      ├─ projects/<pl-id>/originals、clean、imports
                      ├─ projects/<pl-id>/pages/<page-id>/<revision>.json
                      ├─ projects/<pl-id>/detections/<d-id>/task.json、progress.json、worker.log、output/
                      └─ preferences/clipboard.json
預排版 CTD/OCR ─┐
RF/MangaLens ───┼─ 共用 ResourceGate（只協調硬體占用）
ComfyUI 修復 ──┘
```

資料根預設 `<COMIC_DATA_ROOT>/prelayout`，禁止與修圖 projects／jobs 目錄重疊。圖片獨立上傳，沒有跨功能的引用、去重、硬連結或輸入交接。`need_inpaint` 只保存為排版欄位。BT 頂層、分組、未知欄位保留；内部穩定 ID 不寫入 BT 匯出。

CTD 階段沿用來源核心的 OpenCV Telea 生成 `output/inpainted/<stem>.png`（RGBA 透明覆蓋層），再與該項目原圖合成至 `output/backgrounds/`。`complete.json` 的 `inpainted: true` 表示需要完整底圖驗證；發布時核對全批 RGB PNG 尺寸，將底圖複製到新的 `clean/` 資產，再一次更新 detection ID 與頁面引用（`clean_kind: inpainted`）。半成品不替換舊底圖，既有 reader 可繼續讀舊資產；文字修訂與原圖不變。底圖版本改變會更新既有預覽快取鍵，沿用分級與圖塊預覽。此 CPU 影像預處理不涉及神經網路推理後備或 ComfyUI。

對照模式順序為左側編輯圖、右側原圖與偵測框，兩側沿用各自的可見區座標與同一捲動／縮放。`characters.py` 從唯讀 `measure.debug.json`／`measure_ocr.json` 提取單字框；OCR 模式沿用來源的 accepted 字元及 accepted font-fit 條件，FS 優先估算值。worker 生成逐頁 `page-characters/`；舊任務首次讀取時一次建立全批精簡快取，後續僅讀本頁，封存匯入重建派生快取。原始 measure、偵測輸出、文字修訂不改寫。前端以一條 SVG path 畫每頁的單字框；rAF 合併 hover 命中測試，重疊時取最小框，只顯示一份 W／H／FS 提示。該層不接收指標事件，拖曳期間暫停 hover，保持文字編輯與區塊套用可用。

頁面採不可變 JSON 修訂與原子 manifest 發布；文字保存带 `expected_revision` 和冪等操作 ID。瀏覽器按頁訂閱，700 ms 停頓後串行保存；IndexedDB 保存預排版草稿，多分頁版本衝突由使用者選擇。滑鼠拖曳移動與旋轉只在 rAF 更新選中元素的 transform，結束後記錄一次撤銷；點選本身不修改文字或匹配狀態。

`shortcuts.ts` 集中處理文字快捷鍵與相對增減：方向鍵以原圖像素移動 1／10／50，字級增減 2／10，旋轉增減 1°／5°。每條選取文字獨立計算，不套用第一條的絕對值；角度沿用來源核心的 (-180, 180] 範圍，字級限制 1–999。符號鍵兼用 `code` 與 `key`，支援 macOS Option 變更輸入符號及數字鍵盤。`EditorState` 原有 350 ms 分組保留；鍵盤 repeat 可跨初始延遲延續同組，keyup／失焦結束分組，不同操作或選取另記撤銷。未實際改變的上下限操作不寫草稿。輸入框、組字、彈窗與指標手勢期間避讓快捷鍵；點選文字把焦點移回漫畫視窗。Alt 滾輪只在漫畫視窗調字級，普通滾輪仍連續捲動。`TextPage` 選框上方兩角為縮小／放大文字（2／10），下方兩角為逆時針／順時針旋轉（1°／5°）；共用 `adjustedItems` 逐條增減字級或角度，每次點擊記錄一筆撤銷。按鈕阻止 pointerdown 冒泡，避免觸發拖動或清除多選；尺寸隨 scene scale 反向調整，上方拖曳旋轉點保留。這些操作只更新文字狀態，不重新偵測或生成底圖。

`ContinuousPages` 保留可視範圍、前後約一個視窗及操作中的頁面；卸載節點不卸載資料。底圖與文字各自渲染；JPEG 預覽級別為 384／768／1536／3072，巨圖使用可見區圖塊，原圖座標不變。瀏覽器圖片快取上限 256 MiB（估計解碼像素）及 40 項，不是整個瀏覽器記憶體限制；伺服器每項目預覽快取 256 MiB、同時兩個預覽解碼。預覽 reader 不佔用長時間編輯鎖，上傳準備限一份並行。效能證據見 [本地驗證](PRELAYOUT_LOCAL_VALIDATION.md)。

模型任務使用外部 Python 的程序群組，依序全批 CTD／對齊／量測，再按選定方法全批 OCR／字級校準。`COMIC_PRELAYOUT_DEVICE` 預設 `cuda`，本地 Apple Silicon 可明確選 `mps`；設備固定於任務記錄，指定設備不可用即失敗，沒有 CPU 推理後備，MPS 子程序強制停用 PyTorch 的 CPU fallback。兩種設備均先取得共用 GPU gate；CUDA 另檢查 ComfyUI 佇列並卸載閒置模型，本地 MPS 不聯絡 CUDA 的 ComfyUI 服務。每頁回報進度，全部 measure 驗證後才發布新 detection ID；不改原有文字。重新匹配預覽與套用分開，套用時重新核對項目修訂並保護人工條目。

取消以 TERM、等待、必要時 KILL 處理整個程序群組，模型子程序未退出前不釋放 GPU。服務重啟保留所有存活偵測的 GPU 占用；若主程序在寫入 PID 前中斷，按 worker 與任務 ID 尋找原程序。無完整輸出則失敗，完整輸出須重新驗證後發布；不重放推理。程序檢查不可用時不能據此宣稱 GPU 已空閒。此資源機制已做本機程序測試，實際 CUDA 顯存交接仍待遠端驗證。

預排版只透過 `/export/bt` 匯出 `Meo.json`（下載名更新，JSON 結構與內部 API 路徑保持相容）；前端「導出項目」與 `/export/archive` 已移除。項目資料保存在伺服器，關閉頁面後可重開。既有預排版封存仍可匯入：驗證路徑、尺寸、雜湊及修訂，重新分配項目／偵測 ID，清除 PID／重試操作，從已驗證的 measure 重建逐頁快取。worker 日誌由獨立診斷下載端點提供，下載持有 reader 直至完成或客戶端斷線，期間拒絕刪除。

## 項目工作台與三部分邊界

首頁由 `frontend/src/ProjectWorkbench.tsx` 提供項目列表、新建／重開、重命名、用量、封存匯入／導出及確認刪除；「舊版批次與歷史」繼續開啟 `App.tsx` 的原有介面。旧任務仍保留在 jobs，不強制遷移。

- **準備與編輯：**共用 `RasterEditor.tsx` 以原尺寸座標保存 RGBA 填色層、待修補 other 與人工修改 edited。筆刷、矩形、添加／擦除、指定顏色、縮放／平移、撤銷／重做均在瀏覽器預覽，完成操作後保存。F1 純色填充與 F2 待修補互斥，擦除保留原圖；重新偵測保護人工編輯與擦除。

第一部分左側為可編輯「Mask / 原圖」，混合比例 0% 顯示原圖、100% 顯示黑底 Mask；右側為原圖＋實際 overlay 的填色預覽，可另疊待修補標記。兩側使用目前記憶體圖層，在動畫幀更新，不依賴自動保存完成。顯示參數保存在瀏覽器，不改導出資產。偵測成功時同修訂保存可選 `page.detected_text` 灰階 PNG，左侧以其與填色交集加人工範圍显示文字；完整封存保留並驗證此資產。舊項目沒有此欄位時顯示已有選區。背景取樣黃色提示、PS 外擴圈尚未移植，不以填色層冒充。

模型執行裝置由偵測配置明確指定 `cuda:0`、`mps` 或 `cpu`；CUDA 保留既有 ComfyUI 清理及顯存檢查，MPS／CPU 跳過 ComfyUI 依賴，各裝置使用對應遙測，不自動回退。所有偵測仍使用同一資源鎖與逐階段子程序。
- **批量修復：**可由第一部分準備底圖＋Mask，亦可建立項目時直接匯入同名 Mask。提交先保存不可變輸入快照，將 `project_id`、`snapshot_id` 加入既有 job，再交給原引擎。歷史結果繫結當次快照，不隨新草稿改變。
- **比較合成：**僅從項目中已完成的 run 進入，以該 run 的底圖快照比較最多三個候選。候選與底圖的差異 Mask 只限制人工採用範圍，不作模型輸出品質評分。保存原尺寸來源分配、設定和逐頁確認；尺寸不一致不拉伸硬合成。可局部採用、整組採用及保留底圖。畫布即時預覽來源選擇，羽化效果由保存後的伺服器預覽與導出共用同一算法。

第一部分可只導出配對，第二部分可只下載候選，不要求每次走完三段。缺少 RF／MangaLens 或偵測 Python 時，只顯示偵測不可用；其他入口仍能使用。第三部分沒有獨立匯入外部候選入口。

## 項目資料、修訂與交接

`backend/app/projects.py` 是項目儲存入口，使用 JSON 與不可變 PNG 修訂；並未照搬桌面 GUI 的 NPZ 專案。每個項目必須有原圖，使用穩定 ID 而非名稱作目錄鍵。原件保留，工作圖正規化為 RGB PNG；帶有未正規化旋轉方向的輸入會拒絕，不自行單獨旋轉原圖。

```text
<COMIC_DATA_ROOT>/
├── projects/<project-id>/
│   ├── project.json
│   ├── originals/                 # 上傳原件
│   ├── assets/<page-id>/          # RGB 工作圖、初始 overlay/other/edited
│   ├── revisions/<id>/<page-id>/ # 保存後不可變編輯 PNG
│   ├── inputs/<snapshot-id>/
│   │   ├── manifest.json
│   │   └── export_pair/           # 不可變底圖 + other_mask/
│   ├── detections/<id>/           # 偵測狀態、輸入記錄、結果與日誌
│   ├── compositions/<run-id>/     # selection 與原尺寸來源分配
│   ├── result/<run-id>/<revision>/ # 確認成品 PNG／ZIP
│   └── exports/                   # 可重建封存
└── jobs/<job-id>/                 # 原有 job.json、uploads、候選與 logs
```

保存請求帶頁面／項目修訂號，過期請求返回衝突。頁面資產完成寫入後才更新索引；同項目 mutation 使用共享鎖。保存失敗或仍有未保存修改時，前端不默默切頁／導出。`mask_ready` 與全黑 Mask 分開：未準備 Mask 的頁面不能提交推理。

`export_pair` 只是底圖＋待修補 Mask 的交接布局：底圖為規範化原圖疊加確認的純色 overlay，Mask 為確認的 other。直接匯入 Mask 的新項目從透明 overlay 開始；後續更換 Mask 要明確確認並建立新修訂。RF 全文字偵測 Mask 與彩色提示圖都不能替代這組生成輸入。

整批全黑的修復任務直接將當次底圖寫入各選中工作流輸出，記錄 `logs/passthrough.json` 並打包；不等待 ComfyUI、不載入修復模型、不建立無內容比較 PDF。仍遵守應用同時只有一個活動任務的提交限制。混合批次中的全黑頁同樣跳過模型；第三部分將它們以底圖自動確認，維持完整頁數。

## 封存、重開與刪除

完整項目 ZIP 包含帶版本及檔案雜湊的 manifest、原圖、編輯修訂、輸入快照、引用的候選與合成資料；日誌放頂層 `logs/`。目前 run 另提供 `ctd_inpainted/export_pair/` 的可讀配對及候選布局。偵測輸出快取可保留，含執行期 PID／絕對路徑的偵測任務檔不作可恢復任務搬移。

匯入驗證路徑、雜湊、解壓大小和圖像／引用一致性，再分配新 project／job ID；不覆蓋已有項目，不恢復活動 GPU 工作，也不依賴來源伺服器絕對路徑。封存供新網頁續編輯，不承諾桌面 GUI 相容。

「只導出成品」需要全部頁面確認，僅輸出成品 PNG；第二部分候選 ZIP 是獨立下載功能。完整封存與刪除要求穩定狀態。刪除在同項目鎖內檢查活動任务及下載引用，僅清理該項目與明確歸屬 jobs；deleting 狀態允許失敗後重試，不影響無歸屬的舊 jobs 或模型。

## 偵測程序及 GPU 協調

`backend/app/detection.py` 使用與既有 `JobManager` 共用的 GPU gate。新提交在忙碌時被拒絕；內部 FIFO 保留既有任務執行／恢復用途，不代表新增跨項目自動排隊產品功能。

偵測先取得 GPU 保留，檢查 ComfyUI `/queue` 沒有執行或排隊的工作，再以 `/free` 卸載閒置模型並複查佇列。独立偵測 Python 檢查兩份權重、SHA-256、CUDA 及可用顯存後，全批 RF → 全批 MangaLens → CPU 分類；每階段進程退出後才啟動下一階段，不重啟 6006 強行清顯存。外部直接提交 ComfyUI 不受本應用 gate 控制，維護者在偵測期間不得另向 6006 提交工作。

模型 adapter 明確指定 `cuda:0`，沒有 CPU 推理 fallback。進程環境關閉 HF／YOLO 自動下載和自動安裝；服務本身不載入 torch。`backend/imaging/` 保留所遷入演算法來源與授權。

偵測以磁碟 status、進度、逐頁快取、模型載入／執行時間及顯存記錄持久化。完成後先驗證全批輸出尺寸／類別互斥及頁面修訂，再逐頁保存正式修訂。中途寫入失敗保留已落盤修訂，狀態記錄已套用頁面，不自動重放。偵測期间鎖定該項目編輯；取消要等待子進程退出才釋放 GPU。重啟發現舊 PID 仍在時標為 recovery_required 並保持 GPU 保留，程序退出後才能恢復；不能盲目重跑。

偵測依賴的已知 metadata 衝突、隔離安裝例外與 CUDA 待驗收項目均見 [DETECTION_MODELS.md](DETECTION_MODELS.md)。

## 第二部分：既有批量引擎設計目標

- 使用者只需提供原圖與黑白 Mask（可選文件夾或一次多選圖片），不必接觸工作流 JSON 或節點參數。
- 同一個批次可選擇一套或多套正式工作流；多套工作流一律在單張 GPU 上串行執行。
- 對 Qwen 隱藏 RGBA 輸入差異：Web 端仍只接收普通原圖與獨立 Mask。
- 每個工作流保存逐批日誌與每秒一次的整卡顯存採樣。
- 完成後提供一個可直接解壓使用的下載包；三套工作流全選時另外生成比較 PDF。
- 保留既有、已實測的工作流 JSON 與批次器，不在 Web 層重新推導或改寫推理參數。

## 組件與連線

```text
瀏覽器
  │  HTTP :6008（上傳、排隊、進度、下載）
  ▼
React + Ant Design 靜態頁面
  │  /api/*
  ▼
FastAPI
  ├─ 輸入保存與 source/Mask 配對驗證
  ├─ 項目／修訂／封存／合成 API
  ├─ 共用 GPU gate → 獨立 RF／MangaLens 程序
  ├─ 第二部分 FIFO 執行隊列
  ├─ 批次器調度與顯存監控
  └─ 結果、日誌、PDF、ZIP 整理
        │  ComfyUI HTTP/CLI :6006
        ▼
ComfyUI（AutoDL WebUI-6006）
  ├─ Flux2 Klein FP8 + LanPaint
  ├─ FireRed FP8
  └─ Qwen Image Edit 2511 + LanPaint
```

預設端口與目錄由環境變數控制：

| 項目 | 預設值 | 用途 |
|---|---|---|
| `COMIC_WEB_HOST` | `0.0.0.0` | Web 應用監聽位址 |
| `COMIC_WEB_PORT` | `6008` | 使用者入口 |
| `COMFY_URL` | `http://127.0.0.1:6006` | 後端連接 ComfyUI |
| `COMFY_LISTEN` | `0.0.0.0` | 保留 AutoDL WebUI-6006 的 ComfyUI 調試入口 |
| `COMIC_APP_ROOT` | `/root/comic-inpaint` | 應用程式根目錄 |
| `COMFY_ROOT` | `/root/ComfyUI` | ComfyUI 根目錄 |
| `COMIC_DATA_ROOT` | `/root/autodl-tmp/comic-inpaint` | 持久項目、任務、結果與日誌 |
| `COMFY_PYTHON` | `/root/miniconda3/bin/python` | 執行既有批次器的 Python |
| `COMIC_DETECTION_PYTHON` | 無；未設時偵測停用 | 獨立偵測 Python 執行檔 |
| `COMIC_DETECTION_CONFIG` | `<COMIC_APP_ROOT>/config/detection-models.json` | 偵測配置 |
| `COMIC_RF_MODEL`／`COMIC_MANGALENS_MODEL` | 配置中的模型路徑 | 由維護者上傳的偵測權重 |

端口職責固定分離：AutoDL `WebUI-6006` 保留原生 ComfyUI，供維護者調試工作流；`WebUI-6008` 是普通使用者的批量網站。批量後端仍透過 `127.0.0.1:6006` 調用 ComfyUI，不經外部代理。

## 輸入契約

Web 應用接收兩組文件：

1. 原圖：PNG、JPG 或 JPEG。
2. Mask：PNG，轉灰階後值大於等於 128 代表要修復的區域，低於 128 代表保留區域。

配對規則如下：

- 以不含副檔名的 basename stem 配對，例如 `001.jpg` 對應 `001.png`。
- 不依賴文件夾排序。
- 同一文件夾不得有重複 stem。
- 原圖和 Mask 的 stem 集合必須完全一致。
- 原圖與 Mask 尺寸必須一致。
- 忽略 macOS AppleDouble 文件 `._*`。
- 文件夾模式只匯入使用者所選文件夾第一層的圖片，子文件夾圖片不會上傳；亦支援一次多選若干獨立圖片。
- 每次重新選擇文件夾或獨立圖片會整批取代前一次瀏覽器選擇，不累加文件。
- Mask 在進入模型前二值化；全黑 Mask 視為無需修改。

全黑 Mask 不調用任何修復模型，直接把當次提交底圖作為該工作流結果（舊版直接上傳時為該次原圖）。它仍會出現在結果文件夾中，以維持每套工作流輸出數量完整，但比較 PDF 不為它建立頁面。

## 三套正式工作流

正式工作流和順序固定為：

1. `flux2klein_lanpaint`：Flux2 Klein FP8 + LanPaint（Web 預設唯一勾選）
2. `firered`：FireRed FP8
3. `qwen2511_lanpaint`：Qwen Image Edit 2511 + LanPaint

工作流 JSON 位於 `workflows/`。提示詞、步數、採樣器、CFG、LoRA、裁切／拼接幾何與其他已調參數都屬於工作流版本的一部分。除非有明確變更需求並重新進行 GPU 回歸測試，Web 層不得修改它們。

### FireRed 輸入

FireRed 使用獨立原圖與獨立 Mask。批次器啟用平鋪輸入時，放入 `ComfyUI/input` 的必須是實際圖片文件，不能使用符號連結；ComfyUI 0.34 已觀察到會把這類符號連結判為無效圖片。

### Qwen + LanPaint 輸入

Qwen 工作流的節點 168 不直接接收獨立黑白 Mask，而是接收帶 Alpha 的 RGBA 原圖。這個差異由 `runtime-tools/run_independent_edit_models_batch.py` 內部處理：

- RGB 保持原圖內容；
- Mask 二值化後的白色修復區（灰階值大於等於 128）轉為 Alpha 0；
- 其餘區域轉為 Alpha 255；
- 保存後再次確認模式為 RGBA，且 Alpha 方向正確。

因此前端和公開 API 不接受使用者自行製作的 RGBA，也不得把 `pair_mask/*.png` 直接映射到節點 168。

### Flux2 Klein + LanPaint 輸入

Flux 工作流使用獨立原圖與獨立 Mask，由批次器把對應文件名寫入固定工作流節點。

## 任務生命週期

```text
queued → validating → running → packaging → completed
   │          │           │          │
   └──────────┴───────────┴──────────┴→ abandoning → abandoned
                      └────────────────────→ failed
```

1. 後端先保存兩組上傳文件並完成配對、尺寸、格式和黑 Mask 檢查；清理使用者名稱後追加 `_月日_時分秒`，形成唯一的顯示與下載名稱。
2. 任務進入 FIFO 隊列。同一時間最多只有一個 GPU 任務。
3. 全黑整批先走直通輸出；其他批次等待 ComfyUI 的 `/system_stats` 可用。
4. 把本批次輸入複製到獨立的 `ComfyUI/input/web_<job-id>/`；另為 FireRed 建立實際平鋪文件。
5. 按固定工作流順序運行使用者選中的模型；一套完整批次結束後才切換下一套模型。
6. 每個工作流由 `run_with_vram_monitor.py` 包裝，每秒用 `nvidia-smi` 保存整卡遙測。
7. 後端以預期輸出數量判定成功，不能只相信批次器的程序退出碼。
8. 結果正規化為原 stem 的 PNG 文件名，再生成 PDF（適用時）和無壓縮 ZIP。
9. 成功打包後刪除這個任務在 ComfyUI input/output 的暫存；任務結果保留在應用資料目錄。

舊版批次入口採三步向導：圖片與 Mask → 修復流程 → 任務名稱；歷史批次固定顯示在右欄。運行期間整個設定向導隱藏，只保留進度、經二次確認的「放棄任務」和「下載目前已完成結果」。每張完成圖片會先同步到任務結果目錄，因此中途下載或放棄不會丟失已完成頁面。任務 JSON、結果和 ZIP 均保存在磁碟；刷新或重新開啟頁面會從後端恢復當前任務。

服務重啟時，未完成的 `queued`、`validating`、`running` 或 `packaging` 任務會重新回到隊列。已完成的下載包不重新推理。

## 為什麼使用串行排程

2026-09-09 在 RTX 4080 SUPER 32 GB（可見 32,760 MiB）上的兩頁實測峰值為：

| 工作流 | 第一張端到端 | 第二張端到端 | 峰值顯存 |
|---|---:|---:|---:|
| Flux2 Klein FP8 + LanPaint | 48.110 秒 | 17.892 秒 | 31,699 MiB |
| FireRed FP8 | 105.092 秒 | 24.218 秒 | 30,443 MiB |
| Qwen 2511 + LanPaint | 83.916 秒 | 23.347 秒 | 31,505 MiB |

Qwen 與 Flux 距離 32 GB 上限很近。因此「批量三張」代表逐張排隊，不是把三張合成 tensor batch；「三套工作流」也代表模型串行切換，不是同時常駐顯存。第一張包含冷載入，後續圖片通常較快，速度報告必須分開記錄冷／暖結果。

這是已驗證鏡像在特定軟硬體組合上的實測，不是對所有 32 GB GPU 或不同依賴版本的保證。

執行環境、custom node 精確版本／commit、非 Git 節點目錄雜湊及三份工作流 JSON 雜湊統一記錄在 [`config/components.json`](../config/components.json)。架構文件不重複保存長雜湊，以免兩份記錄分叉。

## 輸出契約

每個任務的下載包使用以下結構，只建立實際選中的工作流目錄：

```text
inpaint_workflows/
├── firered/
├── qwen2511_lanpaint/
├── flux2klein_lanpaint/
└── <批次名>-三工作流對比.pdf
logs/
├── <workflow>.log
├── <workflow>_vram.csv
├── <workflow>_vram_summary.json
└── ...
```

比較 PDF 只在三套正式工作流全部選中時生成，欄位從左到右固定為：

1. 原圖 + Mask
2. Flux2 Klein FP8 + LanPaint
3. FireRed FP8
4. Qwen Image Edit 2511 + LanPaint

PNG 已是壓縮格式，ZIP 使用 store 模式以降低打包 CPU 與傳輸文件數開銷，而不是再次高壓縮。

下載吞吐不等於服務器打包速度。若 AutoDL 的 6008／Jupyter 瀏覽器代理下行緩慢，網站保留服務器絕對路徑並提示使用 SSH/SFTP 下載完整 ZIP；這不改變輸出格式，也不把結果上傳到第三方存儲。

## API 邊界

項目相關端點：

- `/api/projects`：項目列表、建立，以及項目讀取／重命名／確認刪除。
- `/api/projects/import`、`/api/projects/{id}/export`、`/api/projects/{id}/export-pair`：完整封存匯入／導出、配對下載。
- `/api/projects/{id}/pages/{page_id}/edit`、`/api/projects/{id}/masks`：有修訂號的編輯保存與整組 Mask 匯入。
- `/api/projects/{id}/jobs`：從已確認草稿建立不可變快照並提交既有引擎。
- `/api/detection/availability`、`/api/projects/{id}/detect`、`/api/projects/{id}/detection`：偵測可用性、啟動、狀態；另有 cancel／recover。
- `/api/projects/{id}/compositions/{run_id}`：合成、頁面影像／來源分配、確認及成品導出。

以下原有批次端點繼續可用：

- `GET /api/health`：應用、ComfyUI、隊列與即時 GPU 狀態。
- `POST /api/jobs`：建立批次，上傳 `source_files`、`mask_files` 和工作流選擇。
- `GET /api/jobs`：磁碟上保留的任務列表。
- `GET /api/jobs/{job_id}`：單一任務進度與錯誤。
- `POST /api/jobs/{job_id}/abandon`：二次確認後安全停止任務並保留已完成結果。
- `GET /api/jobs/{job_id}/download-current`：運行期間打包並下載目前已完成結果。
- `GET /api/jobs/{job_id}/download`：完成後下載結果包。

第一版使用輪詢，後續可在不改變任務狀態模型的前提下增加 SSE。不能因改用 SSE 而移除可恢復的持久化任務記錄。

## 安全與發佈邊界

- 公開鏡像不得含 AutoDL 開發者 Token、SSH 私鑰、密碼、API Key 或瀏覽器憑證。
- 不把使用者上傳、項目原圖／修訂／封存、模型輸出、任務記錄、顯存日誌或 Shell 歷史放進發佈鏡像。
- Web 服務不提供任意文件路徑、任意工作流 JSON 或任意命令執行入口。
- 任務名進入文件名之前必須移除路徑分隔符與控制字元，再由後端追加 `_月日_時分秒`。
- 模型符號連結只指向當前 AutoDL 環境中已確認存在的公共庫／持久盤文件；失效連結必須在啟動前報錯。
- 發佈前先以 dry-run 檢查清理目標，再由維護者明確執行清理。

## 明確不做的事

- 不在 AutoDL 鏡像內再套 Docker-in-Docker。
- 不讓一般使用者編輯提示詞或工作流推理參數。
- 不並行運行三個大型模型。
- 不對 Qwen 生成結果做內容品質閾值、自動篩除或自動拒絕；只驗證輸入與任務是否完整成功。
- 不因工作流可以載入就宣稱環境可發佈；模型、節點、輸入轉換、輸出數量和顯存都必須通過實際 GPU 測試。

## 文件夾選擇補充（2026-09-12）

新建項目使用 `ImagePicker.tsx`，單一拖放／點擊區展開「選擇多張圖片／選擇單個資料夾」選單，參考「去四邊」頁。資料夾選取使用 `webkitdirectory`；瀏覽器可能列舉子目錄，`selectedFiles` 在上傳前依相對路徑只保留第一層、排除 `._*` 與非圖片。拖放沿用 `readDroppedDirectory`，僅為根目錄建立 reader，直到空批次，不開啟子目錄；另支援多張獨立圖片。取消保留原選擇，成功選取整批取代，空目錄顯示提示，讀取期間禁止提交。

舊版批次仍使用 `DirectoryPicker.tsx` 的 `showDirectoryPicker` 與非遞歸拖入。第一部分不再顯示外部 Mask 匯入區，只在建立項目時接受可選 Mask；後端既有資料契約保留。檢測按鈕統一為「自動檢測」，進度映射為中文，模型名稱、裝置及配置錯誤留在維護接口和日誌。

刪除確認使用 React 受控 Modal，由元件管理目標、送出中與錯誤狀態；DELETE 成功才移除卡片。重命名和新舊批次的放棄任務使用 Modal.useModal，避免 React 19 下靜態 Modal.confirm 無法渲染。

## 第一部分選區工具與局部副本

`selection-core.ts` 以原尺寸 0/1 選區實作矩形、套索、8 連通魔法棒、封閉孔洞及局部交集，參照原 `solid_inpaint_ui.py`。局部交集只更動選區碰到的既有連通區；畫筆以整筆選區對筆畫前快照計算。魔法棒固定 seed RGB 容差，擴展後才套用；hover 在 30 ms 合併事件後以同一算法計算新增／移除差量，不修改持久圖層。

`mask-edit-core.ts` 將選區套用到 overlay/other/edited：添加時兩類互斥，減去只動目前類別；框選清除會清兩類並記錄人工排除，框內互換讀取手勢開始時的兩類 Mask，待修補轉純色填充；純色填充先移除選中覆蓋，僅在偵測文字的 3 px 橢圓擴展或人工編輯範圍內轉成待修補（沒有有效文字資料則原範圍轉換）；空白像素及其人工編輯標記保持不變。互換不接收目前類別，與 F1／F2 無關；轉成純色時使用手勢開始時的填色。重新填色作用於本次選區，保留其他填色。原圖、後端修訂格式、Mask 方向及三套推理工作流不變。

`LocalEditWindow.tsx` 接收主畫布記憶體副本的 Object URL；子編輯器只更新本地 draft，不呼叫服務端保存。ROI 支援輸入、邊框拖動及 ±32px，魔法棒先裁 ROI 再找連通區，防止經框外繞回。套用僅合併最終 ROI、形成一次主頁撤銷並自動保存；取消丟棄副本並恢復主頁待保存計時器。副本尚未套用時刷新會提示，局部鍵盤事件不冒泡到主畫布。關閉後釋放 Object URL。

編輯類別以 F1／F2 按鈕常駐，選擇持久於瀏覽器偏好，局部副本仍沿用開窗時類別。Gesture 在 pointerdown 固定 target 與填色，直到釋放都編輯同一類別；拖曳期間忽略類別切換。畫布標題與高亮按鈕顯示一般編輯類別；互換提示固定為「純色填充 ↔ 待修補」，不顯示單向目的類別。

### 氣泡分類同步與確認重建（2026-09-12）

分類核心同步原工程 `be48a98`：文字像素至少 98% 位於同一氣泡多邊形才採局部取樣；其餘含未知位置採完整四向近 3 px／延伸 12 px 背景與顏色一致性檢查。氣泡擴展只補充填色，不覆寫局部分類，待修補及人工保護會阻止相交連通區擴展。前端每頁載入時計算文字修補範圍，互換沿用手勢前副本，撤銷包含被撤掉的氣泡覆蓋。

`POST /api/projects/{id}/detect` 新增 `replace_existing`（預設 false，保留既有呼叫行為）。網頁確認覆蓋整個項目後傳 true：以原圖和任務專用空白 overlay/other/edited 重跑 RF、MangaLens、分類。manifest、status 與頁面 detection metadata 記錄選項；原項目圖層維持至整批輸出通過驗證才回寫。回寫開始前取消、推理失敗及輸出驗證失敗不清空原圖層。重建不改既有修復快照或合成結果；新修復任務使用新底圖／Mask。人工修改保護仍適用預設的非覆蓋 API。

### 項目自動檢測設定（2026-09-12）

新建項目與檢測確認視窗共用 `DetectionSettings`。建立 API 接受 multipart `detection_options` JSON，保存於項目 manifest，並隨封存匯出／匯入；建立不要求模型可用，也不提交推理。`DetectionRequest.options` 固定當次設定：`mask_dilate` 0–64 px、`mask_mode` 四種範圍、`bubble_enabled`、`bubble_shrink_percent` 0–10%。舊項目未保存時使用 availability 回傳的伺服器預設。

提交時將選項寫入任務配置副本、狀態及項目，不修改維護者的配置原檔。關閉氣泡辨識時不載入 MangaLens，不要求其權重或 ultralytics，並忽略舊氣泡快取；availability 的 `available_without_bubbles` 允許僅 RF 準備好的環境開啟設定。裝置及模型路徑仍只由維護配置控制。
## 邊緣塗白獨立模組

`WorkspaceRouter.tsx` 在工作台記住的項目恢復之前處理 `#/edgewhite[/<id>]`。`EdgeWhitePage.tsx` 管理獨立集合；`edgewhite/GuideCanvas.tsx` 使用 SVG 原尺寸座標、四邊標尺與雙欄預覽。離開編輯頁或換頁前等待草稿保存；瀏覽器重載按集合保存的頁 ID 續編。

搜尋函數位於 `guide-snap.ts`，來源為使用者提供的 Mac EdgeWhite commit `bdfbe8b8b42008b40e52ec0427ff9a9c62f637ed`。Web Worker 只持有目前頁的原尺寸灰階快取；RGBA 以 transferable buffer 傳入，換頁終止 Worker。請求世代、頁面／來源雜湊鍵及活動線限制避免過期結果回寫。搜尋評分為完整空白段數，不作語義或內容品質判斷。原圖規範化和輸出使用 `backend/imaging/edgewhite.py`，半開網格矩形與 SVG 相同。

資料集合位於 `<COMIC_DATA_ROOT>/edgewhite/<id>/`：`collection.json` 包含原件／工作圖雜湊、頁序、草稿與輸出修訂；各頁子目錄保存原件、`source.png` 和不可變輸出檔。新集合先寫入 `.upload-<id>`，完成後整體重命名；編輯及輸出完成後原子更新清單。歷史輸出修訂隨集合刪除；ZIP 在回應結束後移除。保存／刪除共用集合 RLock，圖片和 ZIP 回應持有 reader 引用，傳輸失敗也釋放。

`/api/edgewhite` 提供集合建立／列出；`/{id}` 讀取／刪除；`/{id}/pages/{page}/source` 讀取工作圖；`PUT /{id}/pages/{page}` 以預期修訂號保存草稿或輸出；`/{id}/guides` 提供桌面 JSON 導出、JSON PUT 或 multipart POST 匯入；`/{id}/download` 打包所有已確認頁。未更新輸出的草稿回傳 409，舊修訂保存同樣回傳 409。CPU 操作限兩個併發，不佔 GPU gate；建立／匯入與整批下載沿用 GPU 忙碌限制，已載入頁的普通編輯與保存仍可使用。

目錄匯入採 File System Access `values()` 或拖放目錄的 `readEntries()`，只遍歷根目錄的檔案，對子目錄不呼叫任何讀取方法。後者重複讀取同一個 root reader 的分批結果，直到空批次，避免超過 100 個第一層檔案被漏掉。`webkitdirectory` 已從此功能移除。參考：[DirectoryHandle.values](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle/values)、[DirectoryReader.readEntries](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryReader/readEntries)。


### 2026-09-12 匯入入口修訂（取代此前非遞歸選取器方案）

使用者已允許瀏覽器掃描子目錄。新建集合改為單一匯入區：點擊唯一匯入區後，在選單選擇「多張圖片」或「單個資料夾」，也可直接拖入；資料夾模式使用標準 `input webkitdirectory`，不再呼叫 `showDirectoryPicker`。瀏覽器可列舉子目錄，應用只匯入第一層圖片，避免包含 deal 成品。因瀏覽器原生檔案選擇器區分圖片多選及目錄模式，兩種模式由同一入口的選單選取，不再有獨立資料夾按鈕。

內建瀏覽器實測：經資料夾選擇器指定第 82 話目錄，顯示 21 張並略過 1 個子資料夾；點擊主區開啟多選選擇器，選入 2 張測試圖片成功。此前 showDirectoryPicker 的阻塞不再適用於新版入口。lint、build、18 項前端及 61 項後端測試通過。

## 三個工作區合併（2026-09-12）

`codex/prelayout-web`（8cdc3c7）及 `codex/edgewhite-web`（74b4ec8）合入 `codex/project-workbench`。修圖仍為預設入口，首頁增加預排版和邊緣塗白；三部分沒有強制前後依賴。統一的 hash 路由在離開編輯頁前保存，失敗則留在原頁。修圖頁保持掛載並在隱藏時禁止互動，返回時保留原圖片與步驟；附加模組按需載入。

資料分別位於 `<COMIC_DATA_ROOT>/projects`、`prelayout`、`edgewhite`，API 使用獨立路徑；合併不搬移其他工作樹的試用資料。預排版自訂根目錄不得重疊修圖、jobs 或 edgewhite。CTD／OCR 與修圖偵測／ComfyUI 共用 ResourceGate，程序恢復時保留全部仍存活的佔用。原修圖工作流、批次器、輸入轉換與合成核心未改。

## 手塗工作流副本

新增「Flux手塗去字」、「FireRed手塗去字」、「Qwen手塗去字」，使用 ComfyUI 原生遮罩編輯器。原三套生產工作流及網頁批次配置保持不變；使用與部署方式見[手塗工作流說明](../workflows/handpaint/README.md)。目前完成結構檢查，GPU 推理驗收待有卡環境執行。


<!-- comparison-view-review -->
比較合成交互更新：第一張為唯一成品預覽，成功顯示即確認；切頁保留視圖設定，候選面板直接選取採用。所有頁面已確認才可輸出，匯出不代替瀏覽確認。詳細行為見 `docs/COMPARISON_PARITY.md`。本輪僅本地構建與測試，尚未部署遠端。


比較合成提供「多圖對比」「整體＋局部」「區域卡片」，同一瀏覽器記住上次模式。三種方式共用 uint16 像素來源分配、保存、羽化及輸出；切換前保存，失敗時保留原模式。新區域模式使用現有候選及差異 Mask，無新增模型或 GPU 流程；只更新前端構建即可。詳見 `docs/COMPARISON_PARITY.md`。

項目頁右上常駐「導出結果」，與「導出項目」並排。導出先保存並讀取最新合成狀態；仍有待確認頁面時顯示數量並前往第一張待確認頁，不自動替使用者確認整批。全部確認後下載結果 ZIP。僅前端更新。


### 2026-09-13 新建與匯入觸發時機

新建預排版上傳完成後立即詢問 CTD 識別；LP.txt 確認匯入時，若已有完成的 CTD 結果，自動匹配本次匯入頁面並一併保存，其他頁面保持原狀。塗白新建項目可選「建立後立即自動檢測」（預設勾選），上傳建立成功即提交；勾選時明示會取代匯入 Mask。啟動失敗保留已建立項目並顯示可重試錯誤。


### 0.2.1 應用更新檢查

新增所有工作區共用「檢查更新」，目前應用版本 0.2.1；按鈕只查詢固定 GitHub 倉庫的正式數字 Tag，按語義版本比較，排除預覽版，不自動安裝。結果快取 60 秒，網路失敗明示無法檢查。此次應用升級包含新建時啟動檢測及 LP 匯入自動匹配；版本以 0.2.1 Tag 對應此次應用發布。部署更新 backend/app 及前端 dist，保留模型、環境、使用者資料；確認無活動任務後只重啟 Web。

無卡開機的 nvidia-smi 可能拋出 OSError（Exec format error）；健康檢查將其視為 GPU 不可用，仍回傳正常應用狀態。驗證：lint、build、62 項前端測試、199 項後端測試通過；AutoDL 無卡 6008 重啟及健康檢查正常，未執行新 GPU 推理。
