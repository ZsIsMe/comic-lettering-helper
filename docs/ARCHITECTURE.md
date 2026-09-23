# 系統架構

預排版左右字級標示只顯示數字，不加「目前」或「計算」前綴；缺少數值時仍顯示「—」。

本專案以項目串接「準備與編輯 → 批量修復 → 比較合成」。第二部分沿用既有 ComfyUI 引擎、批次器與三份固定工作流；第一部分新增獨立 RF-DETR／MangaLens 推理程序，第三部分是 CPU／Canvas 像素合成。

2026-09-12：上述工作台功能已在本機實作整合；新增 CUDA 環境與模型切換尚待目標 GPU 驗收，本次擴充未部署、未建立新 Tag 或鏡像。本文後段保留原第二部分的輸入、任務及性能記錄，只有明確標示的歷史基線已做過遠端 GPU 實測。需求邊界見 [工作台計劃](PROJECT_WORKBENCH_PLAN.md)，偵測部署限制見 [偵測模型說明](DETECTION_MODELS.md)。

## 獨立資料的網頁預排版

`TextPage` 雙擊文字或 ⌘＋單擊文字時掛載 `InlineTextEditor`，沿用同一文字層的 writing-mode、縮放、旋轉與樣式。純文字 contenteditable 的 DOM、選取與組字區間由瀏覽器管理，React 更新不覆寫輸入內容；原生游標命中測試定位點擊位置。編輯期間隱藏拖曳控制點並隔離鍵盤事件。完成／失焦時只更新該條文字與手動狀態，記一次撤銷；Esc 提交文字、結束編輯並立即 flush 保存。`EditorState` 登記未完成的文字草稿，使離頁提醒識別未保存輸入，並在 flush（保存／匯出／跨工作區）及撤銷前提交。只有完成編輯後才進入既有 IndexedDB 與伺服器自動保存流程。

`editable-text.ts` 共同提供保存文字及 DOM 游標位置對照，統一處理純文字換行、DIV／P、BR 與末尾佔位換行，不重寫瀏覽器正在編輯的 DOM。`caret-navigation.ts` 依明確的換行欄位設定 Selection 位置，取代瀏覽器的 `Selection.modify(line)`：←／→ 移到相鄰欄並記住原字位，短欄夾到欄尾，邊界保持不動；↑／↓ 依 Unicode grapheme 逐字移動。Shift 保留選取起點，點擊、輸入及其他鍵重設記憶字位。組字與系統修飾鍵不攔截，橫排沿用原生游標。

Safari／WebKit 已知限制：多欄直排的實際插入位置可能正確，但原生游標繪製向下偏移。2026-09-20 以相同字型、文字和程式在 Safari 重現；Chrome 測試頁與正式第 7 頁、300% 縮放下，「和」字後按 ↑ 正確停在「曾」字後。現階段直排原位編輯建議使用 Chrome；重啟後端不會修正 Safari 的繪製問題。參考 [WebKit 286961](https://bugs.webkit.org/show_bug.cgi?id=286961) 與 [310592](https://bugs.webkit.org/show_bug.cgi?id=310592)。

`frontend/tests/prelayout-caret.test.mjs` 驗證欄位、空欄、換行及 Unicode 邊界。瀏覽器回歸頁以 `node frontend/tests/build-caret-browser.mjs` 產生於 `var-test/caret-probe/regression.html`，可用本機 HTTP 服務開啟，驗證不同 DOM 結構、縮放、游標位置及真正的 `InlineTextEditor` 原生輸入／保存；不操作使用者項目。

左右字級標示由 `TextPage` 的非互動覆蓋層提供：左側取 `item['font-size']`，右側偵測框取 `measure.font_size`。未選取、選取及原位輸入時均顯示；反向補償頁面縮放，左側另補償文字旋轉，使標示保持可讀。計算值缺失顯示「—」，不觸發重新偵測，不更動輸出資料。

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

`ShortcutHelp` 使用 `shortcuts.ts` 的分組資料，在項目頁標題列下方、工具列上方呈現完整操作表。區塊預設展開、可收起，展開內容限制為約 25vh 並獨立捲動；一般操作、文字編輯、畫面與滑鼠三欄在窄畫面改為兩欄或單欄。舊 `shortcutHelp` 扁平匯出由同一份分組資料產生，保留既有 Modal 或其他呼叫端相容性。

非編輯狀態的文字框剪貼分開處理內部快照與作業系統剪貼簿。⌘／Ctrl＋C 只接受單一所選框並保存完整文字與樣式，不寫入系統剪貼簿；⌘／Ctrl＋V 以該快照在左側編輯畫布指標中心建立完整框；⌘／Ctrl＋P 讀取系統純文字、保留換行，以同一快照作樣式模板建立新框。多選、缺少快照或無有效左側畫布指標時不修改資料並提示。`shortcutBlocked` 繼續使原位編輯保留瀏覽器原生 C／V，P 也不在編輯中攔截。

`ContinuousPages` 保留可視範圍、前後約一個視窗及操作中的頁面；卸載節點不卸載資料。底圖與文字各自渲染；JPEG 預覽級別為 384／768／1536／3072，巨圖使用可見區圖塊，原圖座標不變。瀏覽器圖片快取上限 256 MiB（估計解碼像素）及 40 項，不是整個瀏覽器記憶體限制；伺服器每項目預覽快取 256 MiB、同時兩個預覽解碼。預覽 reader 不佔用長時間編輯鎖，上傳準備限一份並行。效能證據見 [本地驗證](PRELAYOUT_LOCAL_VALIDATION.md)。

模型任務使用外部 Python 的程序群組，依序全批 CTD／對齊／量測，再按選定方法全批 OCR／字級校準。`COMIC_PRELAYOUT_DEVICE` 預設 `cuda`，本地 Apple Silicon 可明確選 `mps`；設備固定於任務記錄，指定設備不可用即失敗，沒有 CPU 推理後備，MPS 子程序強制停用 PyTorch 的 CPU fallback。兩種設備均先取得共用 GPU gate；CUDA 另檢查 ComfyUI 佇列並卸載閒置模型，本地 MPS 不聯絡 CUDA 的 ComfyUI 服務。每頁回報進度，全部 measure 驗證後才發布新 detection ID；不改原有文字。重新匹配預覽與套用分開，套用時重新核對項目修訂並保護人工條目。

取消以 TERM、等待、必要時 KILL 處理整個程序群組，模型子程序未退出前不釋放 GPU。服務重啟保留所有存活偵測的 GPU 占用；若主程序在寫入 PID 前中斷，按 worker 與任務 ID 尋找原程序。無完整輸出則失敗，完整輸出須重新驗證後發布；不重放推理。程序檢查不可用時不能據此宣稱 GPU 已空閒。此資源機制已做本機程序測試，實際 CUDA 顯存交接仍待遠端驗證。

預排版只透過 `/export/bt` 匯出 `Meo.json`（下載名更新，JSON 結構與內部 API 路徑保持相容）；前端「導出項目」與 `/export/archive` 已移除。項目資料保存在伺服器，關閉頁面後可重開。既有預排版封存仍可匯入：驗證路徑、尺寸、雜湊及修訂，重新分配項目／偵測 ID，清除 PID／重試操作，從已驗證的 measure 重建逐頁快取。worker 日誌由獨立診斷下載端點提供，下載持有 reader 直至完成或客戶端斷線，期間拒絕刪除。

## 項目工作台與三部分邊界

首頁由 `frontend/src/ProjectWorkbench.tsx` 提供項目列表、新建／重開、重命名、用量、封存匯入／導出及確認刪除；「舊版批次與歷史」繼續開啟 `App.tsx` 的原有介面。旧任務仍保留在 jobs，不強制遷移。

- **準備與編輯：**共用 `RasterEditor.tsx` 以原尺寸座標保存 RGBA 填色層、待修補 other 與人工修改 edited。筆刷、矩形、添加／擦除、原圖取樣填色、縮放／平移、撤銷／重做均在瀏覽器預覽，完成操作後保存。F1 純色填充與 F2 待修補互斥，擦除保留原圖；重新偵測保護人工編輯與擦除。純色填色顏色只從原圖背景取樣，與自動識別相同，不再使用工具列選色。

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

### Qwen Image 2.1 INT8 輸入

`run_qwen21_batch.py` 先驗證全批原圖與獨立 Mask 的 stem、格式及尺寸。全黑 Mask 直接輸出原圖。非空 Mask 依序二值化（>=128）、補洞、菱形擴張 8px；處理後 Mask 轉 RGB 作為官方 `TextEncodeQwenImage21` 的第二張參考圖，第一張為原圖。補洞沿用已安裝的 KJ 節點，其餘模型、編碼、採樣均採官方原生節點。

模型使用 Qwen Image 2.1 INT8、Qwen3VL 8B INT8 及 2.1 BF16 VAE。沿用已確認中文提示詞，25 steps、CFG 1、Euler/simple、denoise 1、resolution 0，無 Qwen LanPaint、Lightning LoRA 或透明圖層提示詞。解碼後忽略 Alpha、Lanczos 還原原尺寸，以同一處理後 Mask 回貼；只保存一張 RGB 成品。Mask 是參考條件，遮罩外不變由最後回貼保證。

手塗流程從原生 LoadImage 的 MASK 輸出讀取筆刷遮罩，後續處理一致；未塗抹時不要手動排入推理。網頁及持久資料仍保留 `qwen2511_lanpaint` 相容鍵與目錄，**新任務此鍵代表 Qwen 2.1**，不能據此推斷歷史任務的模型版本；舊成品不遷移、不重新推理。每次新任務記錄 runner 工作流 hash 與模型版本。

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

`mask-edit-core.ts` 將選區套用到 overlay/other/edited：添加時兩類互斥，減去只動目前類別；框選清除會清兩類並記錄人工排除，框內互換讀取手勢開始時的兩類 Mask，待修補轉純色填充；純色填充先移除選中覆蓋，僅在偵測文字的 3 px 橢圓擴展或人工編輯範圍內轉成待修補（沒有有效文字資料則原範圍轉換）；空白像素及其人工編輯標記保持不變。互換不接收目前類別，與 F1／F2 無關；轉成純色時依連通區從原圖外圈取樣，不用工具列顏色。重新填色作用於本次選區，保留其他填色。原圖、後端修訂格式、Mask 方向及三套推理工作流不變。

`LocalEditWindow.tsx` 接收主畫布記憶體副本的 Object URL；子編輯器只更新本地 draft，不呼叫服務端保存。ROI 支援輸入、邊框拖動及 ±32px，魔法棒先裁 ROI 再找連通區，防止經框外繞回。套用僅合併最終 ROI、形成一次主頁撤銷並自動保存；取消丟棄副本並恢復主頁待保存計時器。副本尚未套用時刷新會提示，局部鍵盤事件不冒泡到主畫布。關閉後釋放 Object URL。

編輯類別以 F1／F2 按鈕常駐，選擇持久於瀏覽器偏好，局部副本仍沿用開窗時類別。Gesture 在 pointerdown 固定 target，直到釋放都編輯同一類別；拖曳期間忽略類別切換。純色填色顏色在套用時從原圖取樣。畫布標題與高亮按鈕顯示一般編輯類別；互換提示固定為「純色填充 ↔ 待修補」，不顯示單向目的類別。

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


### 0.2.2 網頁升級

0.2.2 加入 6008 網頁安裝器：保存編輯後確認升級，只接受固定 GitHub 倉庫的較新正式 Tag。獨立程序下載 application.zip 與 SHA-256，逐檔校驗並檢查執行環境需求；只更新 backend/app、backend/imaging、backend/prelayout_core、frontend/dist，不覆蓋模型、環境、設定或資料。更新時封鎖其他應用 API，已有請求／GPU 任務時拒絕；備份後只重啟 6008，新版啟動失敗自動回復。狀態與備份存於資料根 updates/。發布前先 build，再用 deploy/build-update.py 產生更新附件並上傳該 Tag 的 Release。0.2.1 需先部署此安裝器一次，後續由網頁更新。

0.2.8 的更新與 ComfyUI 重啟等敏感同頁操作保留自訂請求標頭，並使用 `Sec-Fetch-Site: same-origin` 跨越平台反向代理的 `Host` 改寫；沒有 Fetch Metadata 的舊瀏覽器改核對 `Origin`、`Host` 與 `X-Forwarded-Host`。明確的跨站 Fetch Metadata 一律拒絕。更新包建置器同時校驗兩處版本、同版本 Git Tag 與乾淨工作樹。


### 0.2.3 批量修復計時

批量修復顯示每秒更新的「已運行」，從任務建立起包含準備、模型載入、生成與打包；完成、失敗、放棄時固定「總耗時」。後端保存 finished_at，之後修改其他 metadata 不會延長耗時，舊紀錄使用 updated_at 相容。計時由模擬任務測試驗證，不需要實際執行 ComfyUI；此版作為 0.2.2 → 0.2.3 網頁升級驗收目標。


### 輸出完整性修復（2026-09-17）

ComfyUI 輸出先複製到暫存檔，通過 PNG 完整性與解碼檢查後才發布；流程結束重新同步完整原檔，修復過早複製的副本。比較 PDF 為附加輸出，失敗仍打包圖片與日誌並完成任務，完成訊息保留警告。此修復只需部署後端並重啟 6008，不重啟 ComfyUI。

0.2.4：項目工作台「建立新的修復版本」預設勾選 Flux2 Klein 與 FireRed，Qwen 可自行勾選；舊版批次預設不變。此版本一併包含 PNG 完整性與 PDF 非阻斷修復。

0.2.5：6008 網頁增加 ComfyUI 狀態及手動重啟按鈕。操作保留日誌並核對受管理的 6006 PID，與生成、偵測及升級共用 GPU 互斥；無 GPU 或有任務時拒絕重啟，不自動重跑失敗任務。反覆退出原因仍待定位，此功能是恢復入口。

服務連續失聯時終止批次等待、保存服務日誌並最多自動重啟一次；同一任務恢復次數持久保存，再次失敗由使用者決定。6008 可下載部分結果、手動續跑或明確接受已有候選進入合成；缺少候選會標示，沒有任何候選的待修補頁仍阻止完整導出。手動續跑沿用原任務不可變輸入，只補算缺少／檔案損壞的輸出。


### 0.2.6 新建項目保留上傳 Mask

漫畫修圖項目接受部分頁面的同檔名 Mask；拒絕多餘 Mask、重複檔名與尺寸不一致。新建時只自動檢測缺少 Mask 的頁面，已提供的 Mask（包含全黑）保持不變；全部已有 Mask 時不啟動檢測。檢測未啟動或未完成可按「補充缺少的 Mask」重試；原有明確確認的重新檢測仍可取代圖層。此版只本地測試並發布 GitHub 更新包，未部署遠端、未執行 GPU 推理，無新增模型或依賴。

僅修改「OCR 對齊逐字計算」：CTD 階段同時計算並保留既有單字框字級（相同基準／步長），OCR 校準後取 max（單字框字級，OCR 字級）。measure 保留 font_size_char_box、font_size_ocr 及各自方法，最終方法為 max_char_box_ocr_aligned；缺少可靠 OCR 時保留單字框結果，無可靠單字框時沿用原回退／OCR 結果。OCR 跨行同字的字框 IoU ≥ 0.8 時保留較完整的可靠字框，重複樣本標記 duplicate_overlapping_character 後再做原有 MAD 篩選。獨立「單字框計算」算法保持不變。

## 修圖選區與背景像素處理

`RasterEditor` 的 edit 模式以獨立 SVG 層呈現矩形、筆畫、套索、游標和等待中的操作；高頻 pointermove 只更新原圖座標和幾何輪廓，不掃描像素或合成左右圖。`raster-worker-engine.ts` 在專用 module Worker 中保存正式圖層與歷史，沿用原有選區及填色核心；一個完成手勢是一筆原子操作。合併指標事件保留畫筆採樣，pointerup 納入最後座標，取消不提交。

正式編輯、撤銷／重做、局部合併、歷史重設與 PNG 快照串行執行；非同步編碼也不得被後續操作超越。主執行緒同步登記版本和預期歷史，再交給 Worker；保存排入快照屏障並在新操作到來時繼續保存。Worker 失敗保留未保存狀態並阻止離頁成功回報。

預覽採單一在途請求並合併下一次需求，回傳可轉移的 ImageBitmap；主執行緒檢查頁面實例及需求世代，丟棄並釋放過期畫面，使用 bitmaprenderer 呈現。魔法棒懸停預覽不更動正式圖層或歷史。選區輪廓不依賴右圖完成。現階段重點是隔離阻塞；Worker 內仍使用完整像素陣列和有上限的圖層歷史，未引入 WASM 或區塊化儲存。第三部分 compose 模式維持既有處理方式。

魔法棒懸停使用獨立 requestId 與疊加 Canvas；乾淨的左右 ImageBitmap 只按正式編輯／顯示世代驗證，不因滑鼠移動失效。離開、關閉或提交時立即隱藏並作廢懸停預覽。Worker 保留最多一個同 revision、同完整命令的預算圖層，命中後提交直接採用；所有圖層變更使快取失效。畫筆大小滑塊、數字及方括號快捷鍵共用同一狀態。

魔法棒啟用時，`[`／`]` 改為減少／增加容差，每次 1，限制在 0–100；工具列顯示對應提示，容差改變後重新計算懸停預覽。畫筆仍每次調整 4 px；輸入框與 Ctrl／Cmd／Alt 組合不攔截。

第二輪選區管線：Worker scheduler 保留 FIFO 命令佇列、最新正式 render 與最新 preview 各一槽，每項完成後讓出事件迴圈，再依命令／正式圖／預覽次序取工作。取消預覽帶 beforeId 邊界，回傳正常 null 結果解除 Promise；同步運算中的工作不可中斷。UI 分開兩條在途 render，preview 不再阻擋正式 render 發送。snapshot 從取圖層到 PNG 編碼完成維持命令屏障。

圖層變更以三層 RGBA 實際差量求 bbox（避免純色重採樣及連通區操作超出手勢範圍），保存最多 64 個 revision 的 bbox。UI 傳已呈現 baseRevision，Worker 合併未呈現變更並直接產出 packed rect 像素／小型 bitmap；Canvas 2D 在指定位置貼入。基底不符、歷史超出或顯示設定改變時回復完整重繪。撤銷歷史仍為完整圖層，magicLeft 仍為完整獨立預覽；本輪沒有改成全系統分塊儲存。

魔法棒仍使用固定 seed 色差及 8 連通搜尋；熱迴圈移除逐鄰居 callback。橢圓 morphology 用列上連續區段及差分區間合併，侵蝕用 in-bounds 零值擴展的補集，保留 neutral border 與既有 round／floor 差異。

Morphology 會先統計來源列區段密度；runs > pixels/3 時使用等價 prefix 檢查，避免棋盤格／密集網點的大量短區段使區間法回退。兩條路徑以 frozen oracle 比對。

原圖預載僅接入 edit 模式的 baseUrl；`source-image-cache.ts` 以 URL 與尺寸識別不可變原圖，背景依序預載，限制解碼快取為 64 MiB。ProjectWorkbench 依目前可見頁序安排當頁、後兩頁、前一頁，離開項目清理快取。overlay／other／edited 仍按 revision 重新讀取，導航前保存和項目版本重讀不變。原生 SVG 游標區分矩形、畫筆與魔法棒，熱點為十字中心；指針移動不等待 Worker。

切頁初始化：`ProjectWorkspace` 透過 `RasterWorkerOwner` 延遲建立主編輯 Worker，跨頁借用同一 client；離開 edit、進入 detecting 或退出項目時 dispose。局部編輯仍獨立，借用 editor 的 cleanup 和晚回 init 不得終止共享 client。init 是 FIFO 屏障並使舊 render token 失效；每頁重置圖層、revision、歷史及預覽。傳輸只移交 overlay／other／edited／detectedText 的 owned ArrayBuffer，原圖快取不 detach；Worker 直接接管已隔離的輸入，纯 engine 呼叫仍預設 copy。

`page-load-performance.ts` 在記憶體保留最多 20 次切頁記錄：save.wait（可含 snapshot/upload）、project.reload、並行 assets.*、worker.construct/init 和 firstFrame。total 到首次正式 canvas drawImage 完成，不代表螢幕出光時間。初始化失敗、被新导航取代和離開頁面有獨立狀態；診斷只在開始／完成通知觀察者，不在高頻pointer事件運作。

預排版新增框旁文字顏色／描邊／方向切換，依各選取條目的原值切換並以單次 EditorState.edit 記錄。黑字白描邊，其餘文字黑描邊；描邊粗細從非零切換至 0、從 0 切換至 4。原位分割使用 editable-text 的 DOM／文字映射取得選取範圍，點擊控制項保留文字選取，不直接改寫 contenteditable。將未選取文字與新框以同一次編輯保存，以分割前完整草稿作為撤銷快照，原框中心保持不變，新框位於頁面水平方向右側並繼承樣式、使用獨立 ID，不沿用原偵測匹配關聯。組字期間、空選取與全選不執行分割。

⌘＋單擊只在文字本體進入編輯，不啟動拖曳；框旁按鈕、旋轉及參考框控制點維持各自功能。普通單擊選取與拖曳、多選及雙擊入口保持不變。

## Qwen 2.1 與雙 Release 整合（待 GPU 驗收）

此次使用者授權將 Qwen 2511 批量與手塗兩入口替換為 Qwen Image 2.1 INT8。Flux、FireRed 模型與工作流參數保留。相容鍵／結果目錄 `qwen2511_lanpaint` 保留，介面顯示新模型；舊工作流另存本地備份，不作新工作流載入。舊章節中的 Qwen 2511 效能與 RGBA 規則僅適用歷史版本。

整合環境採已有的 ComfyUI 0.37.0 原生 Qwen2.1 程式與 PyTorch 2.14.0+cu130 隔離環境，仍只開正式 6006 服務。`COMFY_PYTHON` 指向 `/root/comfy-qwen21-venv/bin/python`；啟動指定 BF16 text encoder／VAE 計算，DiT 及文字編碼器權重仍為 INT8。公共庫模型優先復用。不能把修改 JSON 當成舊 0.34 鏡像已具備新模型支援。

雙平台發布及更新規則見 [DUAL_RELEASE.md](DUAL_RELEASE.md)：同一份更新包與 SHA-256 同步 GitHub／Gitee，環境不符時拒絕套用。此次以 0.2.11 同包發布，GPU 回歸由使用者發布後開機測試。無卡檢查不能替代 GPU 驗收；有卡後先一組非空 Mask，再驗證三模型串行切換、黑 Mask 直通、時間／顯存記錄及下載。

## ComfyUI 圖片清理

頁面上方的「清理 ComfyUI 圖片」可查看 input／output／temp 的圖片數量、容量與預覽。已完成且成品完整保存到網頁項目的副本可整批清理；手動／未知圖片按日期篩選及選取後另行確認。清理採使用者掃描時的檔案清單與簽章，刪除前重新核對，不會順帶刪除掃描後新產生的圖片。未完成任務副本、模型、工作流、網頁項目內成品均不屬獨立清理範圍。

刪除網頁項目時先清除該項目確切 job ID 所屬的 ComfyUI 副本；清理失敗保留項目供重試。舊版沒有任務前綴的 Qwen RGBA 不自動推斷歸屬，留在未知圖片清單。應用 GPU gate、修復佇列及 ComfyUI 原生佇列任一忙碌即拒絕清理；直接操作原生 ComfyUI 的維護者也應避免在清理過程提交新工作。


## 0.2.12：各工作流進度與耗時（2026-09-21）

批次及修圖項目共用每工作流進度摘要：等待執行、準備中、運行中、已完成，以及完成張數、首張生成耗時（含模型載入）、非首張平均、工作流累計耗時和動態剩餘估算。網頁及後端狀態文字使用 Qwen Image 2.1 INT8 等顯示名稱，保留內部相容鍵。

耗時取自各批次器成功生成的逐張紀錄，失敗、跳過及全黑 Mask 直通不列入平均。至少兩張生成成功後，以非首張平均乘剩餘生成張數估算，扣除當前張已運行時間；各張尺寸不同時估算可有偏差。累計涵蓋批次器啟動、模型載入、生成及結果同步，續跑累加活動時間、不計停機間隔；同 stem 的既有成功耗時不重複計算。已完成流程凍結數據；舊任務缺少統計時明示未記錄。此修改依使用者授權以 0.2.12 發布 GitHub／Gitee 同包 Release；未部署或更改伺服器。


## 0.2.13：修復完成流程統計被覆寫

流程完成後整理輸出改為重新讀取最新任務紀錄，只更新輸出列表，避免開始前的舊快照覆寫已保存的完成狀態、張數、耗時與時間戳。新增無 ComfyUI／GPU 的三工作流串行整合測試：模擬子程序輸出，保留實際圖片同步、耗時解析與磁碟保存；每次切換流程及全部完成後重新讀取任務，核對統計不變。測試已在修復前重現「已完成退回準備中、耗時清空」。依使用者授權提交並發布 GitHub／Gitee 雙 Release，未部署或修改伺服器；不處理已被舊版本覆寫的歷史摘要。


## 比較 PDF 中文執行報告首頁（未發布）

三工作流比較 PDF 在原圖片對照前加入一頁白底黑字、逐行列示的精簡中文首頁，列任務／日期／圖片數、生成機器 GPU／總顯存／系統記憶體，以及各模型的繪圖模型檔名、首圖耗時、非首圖平均、總耗時和峰值顯存。繪圖模型檔名讀取該批成品內保存的 prompt 中繼資料，不使用目前設定冒充歷史模型；每套模型統計下列當次實際正向提示詞，非空負向提示詞亦列出；原文取自成品 prompt 中繼資料，保持白底黑字，不列其他工作流詳情。黑 Mask 仍不產生圖片對照頁，固定四欄順序保持不變。

`runtime-tools/make_three_model_inpaint_compare_pdf.py` 新增可選 `--logs-dir`、`--job-file`、`--environment-file`；未指定時讀輸入根下 `logs/` 和 `job.json`。環境 JSON 支援 cpu_model、ram_total_mib、os、app_version、comfyui_version、pytorch_version、cuda_version、driver_version。監控器在生成開始前保存每流程 `*_environment.json`，只讀本機及內部 ComfyUI 資訊，不載入 PyTorch／模型；PDF 只讀保存的快照，不探測製作 PDF 的電腦。

逐張平均排除失敗／跳過／直通；資料缺失顯示未記錄，不以零或目前環境代填。日誌優先於任務進度摘要，顯存為整卡採樣占用；有自動續跑備份時合併成功圖片紀錄並註明總耗時及顯存只涵蓋最近一次執行。此修改提交並推送，未打 Tag 或發布 Release，未同步正式應用。曾在伺服器獨立報告目錄使用既有結果生成 PDF，不修改任務資料。依專案約定不渲染或驗證生成 PDF；測試使用合成日誌和保存呼叫攔截，驗證統計及首頁插入流程。

PDF 中文字型：支援 `CJK_FONT_PATH` 及腳本旁 `fonts/SourceHanSansTC-Regular.otf`；缺少中文字型時明確停止，不再退回預設字型輸出亂碼。

2026-09-21 提示詞調整：三套批量與手塗工作流統一移除普通文字、擬聲詞、效果字及殘留筆畫，保持原有色彩與氣泡；移除黑白漫畫限定及灰綠色定位措辭。執行腳本備用提示詞同步更新。此變更尚待 GPU 品質回歸，未新增網頁提示詞編輯功能。

2026-09-22：三套正式流程（批量與手塗）均在模型採樣前接入 `ModelAttentionBackend`，選擇 `comfy kitchen attention`。當前 ComfyUI 0.37.0 環境已用兩組彩圖測試三套模型；僅更換 Attention 後端，提示詞與採樣參數不變。現有伺服器更新工作流 JSON 即可，新任務生效；已開啟的 ComfyUI 畫布需重新載入，無需升級鏡像或重啟服務。其他環境需確認該節點與 Kitchen 後端可用。速度測試不代表輸出品質已人工驗收。

三套網頁批次統一讀取應用 `workflows/` 內嵌模板；FireRed 指定 `FIRERED_BASE_WORKFLOW`，Flux 指定 `--workflow-override`，Qwen 指定 API JSON。應用更新無需覆蓋 ComfyUI 使用者工作流副本；後者僅供原生畫布使用。

## 0.2.14：內嵌工作流加速與英文 PDF

三套內嵌模板啟用 Kitchen Attention、統一保留色彩和氣泡的去字提示詞；網頁直接讀應用模板。比較 PDF 改為英文並使用 Pillow 內附字型，不再依賴中文字型。當前統一提示詞顯示標示的英文翻譯，歷史非英文內容以 Unicode escapes 保留；原文及統計另存同名 `.report.json`，不修改推理提示詞。舊鏡像（ComfyUI 0.37.0／comfy-kitchen 0.2.35）5090 上兩張彩圖、三套共六次生成通過；其他環境不在本次驗收範圍。

## 0.2.15：預排版分組、差異高亮與固定字級

分組仍以 LabelPlus 相容的 `groupList` 陣列與文字 `groupId` 索引關聯；重新命名只更新同一索引的 `name`，保留其他 JSON 欄位，管理介面與後端均禁止縮短既有分組。差異高亮由前端按原圖與去字圖像素生成中性遮罩，顏色／透明度只影響顯示並保存於瀏覽器，不改圖片或匯出資料。固定字級模式沿用 CTD 區塊偵測、對齊、來源樣式分析及去字預覽，只省略 mask 逐字量測、OCR 與字級校準。
