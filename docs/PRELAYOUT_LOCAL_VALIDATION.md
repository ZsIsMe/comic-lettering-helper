# 預排版本地驗證

日期：2026-09-12。工作樹：`/Users/zhongsheng/Documents/ChatGPT/autodl/worktrees/comic-prelayout`；分支：`codex/prelayout-web`，從 `codex/project-workbench` 的 `ad7bfc0` 建立。程式記錄於同一 Git 工程的本地分支，未合併回原分支、未推送、未部署或製作鏡像。

## 驗證結論與範圍

後續輸出需求調整：預排版移除「導出項目」及 `/export/archive`，僅匯出 `bt.json`；既有項目與伺服器保存保留。此調整已重新通過 lint、build、77 項後端測試及正式本機 API 檢查（BT 為 HTTP 200、下載名 `bt.json`；ZIP 匯出為 HTTP 404）。既有瀏覽器資料測試已改為 BT 往返；本次未重跑瀏覽器腳本，因瀏覽器工具對本機 origin 的存取被自動審核拒絕。下方四組瀏覽器及 MPS 效能數據為此前完成的驗收。

本地功能、79 項後端測試及四組合成資料瀏覽器驗收通過；追加的使用者 17 頁漫畫 CTD／OCR 真實 MPS 推理及瀏覽器驗收也已通過。真實 CUDA 推理、目標 Linux 環境、顯存交接和乾淨鏡像驗收尚未完成，不能以本報告代替。

初次功能驗收使用自行生成的灰色格線圖片與合成文字。CTD 核心探針以固定假偵測器替代神經網路輸出，實際執行對齊、字框量測、樣式分析和 OCR 裁切流程；該探針無 GPU 推理。後續依使用者要求新增真實 MPS 測試，資料與結果另列於下節。五項模型／字型資產從參考工程讀取校驗，未複製進本工程。

## 真實本地模型測試（MPS）

使用者指定漫畫資料夾，共 17 張 1080 × 1536 JPG；其 `total.txt` 為 LabelPlus，含 135 條譯文、框內及框外兩組。透過正式 `/api/prelayout` 上傳、匯入、背景任務、發布與匹配流程建立「居酒屋女大16（本地模型測試）」；沒有直接改寫量測文件或原始資料。

設備為 Apple M1 Pro／32 GiB，外部 Python 3.14.6、PyTorch 2.13.0、torchvision 0.28.0。明確設定 `COMIC_PRELAYOUT_DEVICE=mps`，`PYTORCH_ENABLE_MPS_FALLBACK=0`，兩方法串行執行，CTD 子程序退出後才載入 OCR。預檢回報 `mps_available=true`、`cuda_available=false`；推理成功證據來自正式任務完整輸出與日誌。

| 方法 | 完整流程耗時 | 結果 |
| --- | --- | --- |
| CTD 單字框計算 | 36.230 秒 | 17／17 頁，136 個文字區塊，已發布 |
| CTD＋OCR 對齊逐字計算 | 44.287 秒 | 17／17 頁，136 個文字區塊，OCR 字級校準完成並發布 |

耗時由 API 提交至一秒輪詢觀察到完成，包含資產預檢、模型載入、對齊／量測、OCR（如適用）和發布，不是純神經網路執行時間。兩次任務均未改動既有譯文；完成後 GPU gate 已釋放。17 張原圖及 `total.txt` 的 SHA-256 與測試前一致，模型仍在工程外。

經網頁套用 OCR 結果後，135 條譯文中有 110 條自動匹配、13 條未匹配、12 條重複匹配待確認；待處理條目保留給人工檢查。API 摘要的 `automatic: 135` 表示參與自動匹配的條目數，不表示 135 條全部成功。初次測試尚無去字底圖，預覽使用原圖並疊加譯文；後續已補接下節的 `inpainted` 預覽。

同批資料在 Chrome 153.0.8010.36、1440 × 1000、DPR 1 測試：10 秒文字移動的 P95 幀間隔 16.8 ms，10 秒旋轉為 16.7 ms；兩者 pointer-to-rAF P95 約 0.2 ms，手勢期間沒有保存或底圖請求。測試修改已撤銷還原。上下捲動及首尾頁切換通過，最多掛載 4 頁，估算圖片解碼快取約 33.2 MiB，低於 256 MiB 預算；量測資料保持唯讀，無瀏覽器執行錯誤。這是本機條件下的測試值，不代表所有裝置或真實螢幕延遲。

報告、輸入雜湊、逐方法日誌與截圖位於 Git 忽略的 `var-test/prelayout-local-models/`；測試項目位於 `var-test/prelayout-browser/runtime/prelayout/projects/`。本機 6018 服務目前使用外部 `/private/tmp/comic-prelayout-local-models` 連結目錄，指向 README 資產表列出的現有檔案；服務使用期間保留這些連結。重開機後如目錄消失，須先重建連結或指定另一個持久外置目錄。

## 追加 inpainted 預覽驗證

接入來源核心的 OpenCV Telea（radius 3、mask expansion 5），先用合成文字頁＋空白頁跑正式 CTD／OCR 與預覽發布，再跑使用者既有 17 頁項目。兩次都使用明確 MPS 配置，沒有上傳去字圖、執行 ComfyUI 或新增模型；合成測試項目已清除。

17 頁共生成 17 份 RGBA `inpainted` 覆蓋層與 17 份合成底圖，全部原尺寸驗證及 768 級別預覽請求通過。CTD／OCR／預覽／發布約 45.30 秒完成，連同全部產物和預覽讀取檢查約 45.889 秒。空白頁覆蓋層全透明，合成底圖像素與原圖相同；17 頁文字修訂及 BT 內容與執行前一致，原圖 SHA-256 保持一致。GPU gate 已釋放。

新增後端檢查覆蓋透明與半透明 Alpha 合成、尺寸拒絕、缺頁時保留舊發布、原有人工文字保留，以及新底圖的預覽快取鍵。lint、build 與 79 項後端測試通過。此次沒有重跑瀏覽器效能測試；先前 browser-use 的本機 origin 存取限制仍未解除，不把原圖底圖的歷史效能數據當作新底圖實測。

紀錄保存在 Git 忽略的 `var-test/prelayout-local-models/inpainted-report.json`、`inpainted-backend-tests.txt` 及 `*-inpainted.log`。生成圖片位於該項目偵測的 `output/inpainted/`、`output/backgrounds/`，已發布底圖透過新的 `clean/` 引用使用既有預覽 API；排版匯出仍只有 `bt.json`。

## 追加文字快捷鍵驗證

新增 `npm --prefix frontend run test:prelayout-shortcuts`，8 組離線測試直接執行正式 TypeScript 快捷鍵處理、座標變換及 EditorState 撤銷邏輯。涵蓋移動 1／10／50 原圖像素、多選不同字級與角度、Mac Option 改變符號、Control／Command 及數字鍵盤、字級上下限、角度跨界、IME 組字避讓、650 ms 初始長按延遲後仍一次撤銷、放開／切換操作拆分及重做。

測試只用記憶體合成文字與受控時鐘；IndexedDB 和保存排程為測試替身，不開啟瀏覽器、不接觸使用者漫畫或服務。頁面另恢復 Option／Alt 滾輪調字級、PageUp／PageDown、Q，並加入快捷鍵說明及選框四角的 1°／5° 旋轉按鈕（共用已測試的旋轉運算）。此次瀏覽器 origin 限制仍未解除，因此未驗證實際瀏覽器按鍵、焦點、滾輪、四角按鈕排布與點擊或快捷鍵效能；既有拖曳歷史數據不代表此次驗收。

本輪重新通過 lint、build、8 組快捷鍵測試及 79 項後端回歸。以唯讀 HTTP 檢查確認本機 6018 健康回應 200、GPU gate 空閒，所提供的 HTML、預排版 JS 與 CSS 雜湊和本次構建一致；使用者刷新可載入更新。未重啟服務、執行模型、提交或部署遠端。

## 追加左右對調與單字框驗證

對照改為左編輯、右原圖；「偵測框」同時顯示區塊與單字框，hover 顯示 W／H／FS（例如 `W25H24FS26.8`）。新增測試覆蓋 OCR 與字級接受條件、legacy 排序、無效框排除、計算方法選擇、派生快取重建、原始資料不變、標籤格式與最小重疊框命中。

本輪 lint、正式 build、10 組前端邏輯測試及 83 項後端測試通過。權限範圍變更後，Vite 共用依賴暫存及既有程序管理測試先受沙箱限制；以核准的必要權限重新執行後通過，未修改測試以跳過驗證。

本機服務恢復於 127.0.0.1:6018，既有 17 頁項目讀出 990 個可靠單字框；整批 API 讀取與靜態版本核對約 0.106 秒。原始 measure／debug／OCR 與各頁排版檔案雜湊不變，未重新執行模型；生成的只有逐頁快取。報告位於 Git 忽略的 `var-test/prelayout-local-models/character-overlay-report.json`。應用已接收開啟頁面的排程；本輪未透過瀏覽器工具重測畫面與實際 hover，因此 API 耗時不能當作互動效能。

## 自動檢查

| 檢查 | 本機結果與限制 |
| --- | --- |
| `npm --prefix frontend run lint` | 通過 |
| `npm --prefix frontend run test:prelayout-shortcuts` | 8 passed；離線邏輯與撤銷測試，未啟動瀏覽器或使用本地模型 |
| `npm --prefix frontend run build` | 通過；預排版為約 47 kB 的按需載入分塊，既有主 bundle 仍有大於 500 kB 的 Vite 提示 |
| `.venv/bin/python -m pytest -q backend/tests` | 79 passed；包含 inpainted 合成與完整發布、CUDA 預設、MPS 外部程序、設備不可由請求覆寫、CPU 拒絕及缺資產失敗；一項既有 Starlette／AnyIO 棄用提示 |
| `make verify-local` | 已執行，19 項外部環境缺失：本機沒有 `/root/ComfyUI`、六個 custom nodes、三個已安裝工作流及九個正式修復模型；倉庫工作流雜湊和前端构建通過 |
| `prelayout_core.check`（未加 `--require-cuda`） | 五項 SHA-256、核心依賴及字型指標通過；`cuda_available=false`、`inference_verified=false` |
| `prelayout_core_probe.py` | 兩種字級方法的合成對齊／量測及 OCR 裁切契約通過，包含空白頁；非模型成功證據 |
| `git diff --check` | 通過 |

後端測試包括自然排序、輸入配對、資料根隔離、JSON 非有限數字拒絕、修訂衝突與重試冪等、BT 未知欄位往返、LabelPlus 分組、原圖／去字圖／局部預覽、原圖雜湊、唯讀量測、人工匹配保護、封存路徑／資產驗證、新 ID、量測快取重建、下載斷線 reader 釋放、解碼期間保存、清理僅作用於合成資料及外部模型保留。

程序測試實際建立程序群組及忽略 TERM 的子程序，驗證服務恢復找回尚未記錄 PID 的 worker，取消時仍占用 GPU gate，子程序退出後才釋放。另實際啟動正式 worker 入口，模擬可用性檢查後資產消失，確認留下失敗日誌、不發布新量測且釋放資源。原修圖偵測測試改用正式 ResourceGate，完整回歸通過。

## 瀏覽器與效能條件

- 硬體：Apple M1 Pro、32 GiB RAM；macOS 26.5.1 arm64。
- 瀏覽器：Chrome 153.0.8010.36，獨立無頭測試 profile，1440 × 1000、DPR 1；另驗證 600 × 900 窄視窗。這是本機 rAF／trace 基線，不是所有瀏覽器或真實顯示器的 FPS 承諾。
- 100 頁合成資料：普通頁 2000 × 3000，每頁 35 條；第 97 頁 240 條、字級 48、描邊 10 px；第 98 頁 8000 × 12000（96 MP）；第 99 頁 1200 × 24000。
- 指標在預覽暖快取後採樣。一般驗收對文字保存及圖片預覽分別注入 500 ms 延遲；拖動過程不發出保存或新預覽請求。

| 項目 | 實測 |
| --- | --- |
| 一般文字拖曳 10 秒，幀間隔 P95 | 16.8 ms |
| 一般拖曳 pointer → 下一次 rAF，P95 | 0.2 ms |
| 240 條粗描邊文字拖曳 10 秒，幀間隔 P95 | 16.7 ms |
| 同頁連續旋轉 10 秒，幀間隔 P95 | 16.7 ms |
| 旋轉 pointer → 下一次 rAF，P95 | 0.3 ms |
| 旋轉 trace（含選取、結束保存） | 4 次 Layout、48 次 Paint；沒有每個 pointer 事件都重排整頁 |
| 50%／適合寬度／200% 實際頁面縮放 | 原圖座標誤差約 0.00002079 px，伺服器 x/y/rotation 不變 |
| 100 頁、巨圖／超長圖、三輪捲動 | 記錄時掛載 2 頁；測試斷言不超過 4 頁；巨圖及超長圖有可見區圖塊 |
| 最後一輪估計圖片解碼快取 | 101.9 MiB、18 項、2 個活動引用；低於 256 MiB／40 項預算 |
| 三輪後測試瀏覽器相關程序 RSS 加總 | 1295.3 MiB → 1267.4 MiB → 1235.1 MiB |

rAF 延遲只是下一次視覺更新的代理，並非實際掃描到螢幕的精確延遲。程序 RSS 由 Chrome 提供的程序 ID 與 `ps` 取樣，包含 renderer／GPU／utility 等，可能重複計入共享記憶體；不等於唯一實體用量。快取預算也不等於瀏覽器總記憶體。三轮觀察未隨歷史頁數持續增長，較長工作階段與目標裝置仍應用真實資料觀察。

## 瀏覽器功能證據

| 腳本 | 已驗證行為 |
| --- | --- |
| `frontend/tests/prelayout-browser.cjs` | 弱網拖曳、旋轉符號、一次操作一次撤銷、連續微移分組、F1／F2 指標貼上、指標縮放錨點、第 100 頁／刷新位置、對照、巨圖／超長圖、三輪快取／RSS、人工匹配保護、唯讀 measure、BT 匯出、返回修圖後無殘留文字快捷鍵 |
| `frontend/tests/prelayout-render-browser.cjs` | 密集／粗描邊拖曳與連續旋轉、Chrome trace、實際縮放比例及座標不變、Pointer cancel |
| `frontend/tests/prelayout-data-browser.cjs` | 新建、缺模型／字型下人工編輯、窄視窗、BT、文字換行、常用框與暫存分離、409 衝突選擇、503 保存失敗／IndexedDB 刷新恢復、LabelPlus 框內外分組、待處理跳轉、去字圖、ZIP 重開、改名／刪除 |
| `frontend/tests/prelayout-edit-browser.cjs` | 單純選取不產生修訂／不改匹配狀態、多選拖曳、批次字級和撤銷、旋轉後調整參考框、取消調框後還原 DOM／資料、描邊標記、橫直排及中英數字／標點 |

已查看實際截圖 `editor.png`、`dense-editor.png`、`narrow-editor.png`、`text-styles.png`。頁面採同一連續捲動區；窄視窗收合頁碼欄、工具列換行；混排和描邊採固定字型與瀏覽器直排規則。這些截图是合成資料的外觀驗證，不代表已做漫畫內容校對。

## 重現方式

從本工作樹執行。前端建置與 Web 後端使用既有開發依賴；此處 `.venv`／`frontend/node_modules` 是指向原工作台現有環境的本機連結，不進 Git／發行包。重新建立環境按 AGENTS.md 安裝。

```bash
npm --prefix frontend run lint
npm --prefix frontend run build
.venv/bin/python -m pytest -q backend/tests
make verify-local

# 建立新的獨立合成資料集；fixture.json 會提供其項目與頁面 ID。
PYTHONPATH=backend .venv/bin/python backend/tests/make_prelayout_fixture.py \
  --data-root var-test/prelayout-browser/runtime --output var-test/prelayout-browser

# 使用本機測試資料，ComfyUI 指向未啟動的測試端口，避免碰到正式服務。
COMIC_APP_ROOT="$PWD" COMIC_DATA_ROOT="$PWD/var-test/prelayout-browser/runtime" \
COMFY_URL=http://127.0.0.1:6199 \
COMIC_PRELAYOUT_MODEL_ROOT=/Users/zhongsheng/Projects/comic-text-detector/assets/fonts \
.venv/bin/uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 6018 --no-access-log
```

另開終端依序執行，避免並行瀏覽器干擾效能採樣。`PRELAYOUT_PLAYWRIGHT` 指向現有 Playwright 模組（或可直接 `require('playwright')` 的環境），`PRELAYOUT_CHROME` 指向測試 Chrome 可執行檔；未指定 Chrome 時使用 Playwright 已安裝的瀏覽器。此環境使用 Codex bundled Playwright 及 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，未把瀏覽器或依賴複製入工程。

```bash
export PRELAYOUT_PLAYWRIGHT=/Users/zhongsheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright
export PRELAYOUT_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node frontend/tests/prelayout-browser.cjs
node frontend/tests/prelayout-render-browser.cjs
node frontend/tests/prelayout-data-browser.cjs
node frontend/tests/prelayout-edit-browser.cjs

# 使用參考工程已存在的外部推理 Python，跑合成核心契約（不推理）。
COMIC_PRELAYOUT_MODEL_ROOT=/Users/zhongsheng/Projects/comic-text-detector/assets/fonts \
PYTHONPATH=backend /Users/zhongsheng/Projects/comic-text-detector/ctd_overlay_processor/.venv/bin/python \
  backend/tests/prelayout_core_probe.py --output var-test/prelayout-browser/core-report.json
```

初次合成驗收的機器可讀報告、trace、截圖、ZIP 和測試資料保留於 Git 忽略的 `var-test/prelayout-browser/`，當時預檢用的短期連結已移除；後續真實模型服務使用上節列出的另一外部連結目錄。資產均未移動或改寫。部署預檢請使用鏡像的正式外置模型目錄。

## 尚待部署環境驗收

1. Linux Python／PyTorch／torchvision／CUDA 的精確依賴組合與環境封存。
2. 在目標 CUDA 執行兩種字級方法的真實模型 smoke test、多頁／無文字頁、產物與人工匹配驗收；本機 MPS 的 17 頁實測已完成。
3. CTD／OCR 與既有修圖／RF／MangaLens 的顯存交接、異常／取消／重啟。
4. 6008 代理環境下的真實瀏覽器、固定字型、大圖、下載及弱網測試。
5. 乾淨鏡像檢查、敏感資料與預排版資料清理、Git commit／Tag／鏡像版本記錄。

操作順序見 [部署準備](DEPLOYMENT.md#預排版部署準備)。本次本地測試服務只綁定 `127.0.0.1:6018`，未操作 AutoDL。
