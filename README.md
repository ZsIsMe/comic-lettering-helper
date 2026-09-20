# 漫畫去字工作台 · AutoDL 發行工程

本倉庫提供以項目為單位的漫畫修圖網頁：保存原圖與編輯，生成待修補 Mask，執行三套既有 ComfyUI 工作流，再比較候選並局部合成成品。

使用說明見 GitHub Pages 操作指南：<https://zsisme.github.io/comic-lettering-helper/>。

**2026-09-12 部署狀態：**修圖項目、預排版及邊緣塗白已整合並部署至 AutoDL 網頁服務。獨立模型與配套檔案已上傳並通過檔案校驗，推理環境已安裝；RF 環境檢查與服務配置接入尚待完成。伺服器目前無卡運行，新增模型尚未完成目標 GPU 推理驗收；未建立新 Tag 或鏡像。既有三工作流的歷史成功記錄不代表新增偵測環境已驗證。

## 模型介紹與下載

RF、MangaLens、CTD、OCR 的用途、下載地址、配套字表／字型、存放位置及 SHA-256 集中於 [獨立模型說明](docs/MODEL_GUIDE.md)。模型另外下載或上傳，權重不放入 GitHub；邊緣塗白和人工編輯不需要模型。

## 使用流程

1. **建立或重開項目。** 每個項目必須包含原圖；可同時上傳同 stem 的 Mask，直接進入第二部分。首頁顯示頁數、更新時間及儲存用量，提供匯入、導出和確認刪除。
2. **準備與編輯。** 可使用「自動檢測」或直接人工編輯；自動檢測先確認，從原圖重跑整個項目並以新結果覆蓋填色、Mask 與人工修改；外部 Mask 僅在新建項目時匯入。畫布提供矩形、畫筆、魔法棒、套索、局部視窗，依目前 Mask 類別進行添加／減去／局部交集；魔法棒另有選區內部、選區＋選區內部、容差／擴展及點擊前預覽。右鍵框選清除兩類 Mask，Cmd／Ctrl＋右鍵互換框內的純色填充與待修補 Mask，清除另有可直接選擇的按鈕，互換僅用快捷手勢。局部副本套用後才回寫；支援縮放、平移、撤銷／重做及保存。可單獨導出底圖＋Mask。
3. **批量修復。** 確認後以不可變快照提交既有引擎，按 Flux2 Klein FP8＋LanPaint、FireRed FP8、Qwen Image Edit 2511＋LanPaint 串行處理，預設只選 Flux。提示詞及已調參數不變。
4. **比較合成。** 從完成的修復任務開啟同步比較，使用筆刷或矩形局部採用候選、整組採用或保留底圖。保存像素來源分配，確認各頁後只導出成品。拖動畫布顯示即時採用預覽；羽化效果以保存後的伺服器預覽及導出為準。

三部分可分開使用：已有 Mask 可跳過偵測；只需模型候選結果可在第二部分下载，不必進入第三部分。第三部分僅接本項目的完成任務，不提供外部候選圖獨立匯入。

「導出項目」保存可續編輯的原圖、修訂、輸入快照、候選及合成記錄，供新網頁工作台重新匯入；「只導出成品」只包含確認後的 PNG。項目保存在伺服器，重新開啟網頁可繼續工作；完整封存不依賴原伺服器路徑，也不承諾桌面 GUI 能直接讀取新版項目格式。

首頁保留「舊版批次與歷史」入口。原有三步提交向導、任務列表、進度及候選 ZIP 下載繼續可用，舊任務不強制轉成項目。

## 預排版功能

「OCR 對齊逐字計算」先保留原有單字框算法的字級，再與 OCR 字級取較大值；兩者沿用設定的基準字級及步長。OCR 同一位置、同一字且跨行高度重疊的樣本只計一次，再套用原有離群值篩選。「單字框計算」模式維持原算法。既有偵測結果不自動覆寫，新偵測才使用此規則。

頁碼導覽位於頂部工具列下方，橫向排列並自動換行，不佔左側欄位；頁數較多時導覽區最高佔視窗 25%，其餘頁碼可在區內捲動。既有點頁跳轉、目前頁高亮、連續捲動與顯示切換邏輯保留。

預排版已從 `codex/prelayout-web` 合入 `codex/project-workbench`，入口為修圖首頁「預排版」或 `/#/prelayout`。它與圖片修復分別管理圖片、項目、文字進度、常用文字框及輸出，不需要先修圖。介面採連續多頁上下捲動，支持 BT／LabelPlus 匯入、文字移動／旋轉／參考框調整、橫直排、樣式、多選、撤銷／重做及獨立草稿恢復。排版只匯出 `Meo.json`，不提供「導出項目」或項目 ZIP 匯出；項目仍保存在伺服器，關閉網頁後可重開續編。

底圖使用分級預覽及可見區圖塊，文字保持獨立渲染；移動／旋轉期間凍結底圖，結束後保存。低解析度只影響預覽，原圖和排版座標保持原有精度。CTD／OCR 的量測結果保存為唯讀版本，匹配需明確套用；沒有角度測量工具或人工編輯 `measure.json` 的入口。獨立倉庫與桌面端打包不在此次範圍。

CTD 流程同時生成來源核心的 `inpainted` 去字預覽：沿用 OpenCV Telea（radius 3、mask expansion 5），把 RGBA 覆蓋層疊回原圖後作為預排版底圖，不必先上傳去字圖。全部頁面驗證完成後才切換底圖；原圖與排版文字保持不變，可隨時切回原圖。這是排版預覽，不调用三套修圖工作流，也不與修圖模組共用圖片。生成的底圖仍使用既有分級預覽及圖塊快取。

**部署狀態：預排版及邊緣塗白已合入本地 `codex/project-workbench`，尚未推送或部署 AutoDL，未建立 Tag 或鏡像；CTD／OCR 真實 CUDA 推理與共享顯存切換仍待目標 GPU 驗收。** 詳見 [實作計劃與範圍](docs/PRELAYOUT_IMPLEMENTATION_PLAN.md)、[本地驗證](docs/PRELAYOUT_LOCAL_VALIDATION.md)及 [部署準備](docs/DEPLOYMENT.md#預排版部署準備)。

勾選「原圖對照」後，左側為預排版編輯圖，右側為原圖。勾選「偵測框」同時顯示文字區塊與單字框；滑鼠停在單字框上會顯示如 `W12H12FS22.0` 的提示，W／H 為原圖像素寬高，FS 優先使用估算字級。沿用原程式的 OCR／字級篩選結果；既有偵測資料可直接顯示，無須重新推理。

「上傳去字圖」入口目前隱藏，介面使用生成的 `inpainted` 預覽；底層去字圖匯入功能與既有資產保留。

檔案入口名稱為「開啟 Meo.json」「匯出 Meo.json」「匯入LP.txt」。匯出下載名為 `Meo.json`，沿用既有 JSON 結構及舊檔相容性；LabelPlus 仍匯入 `.txt`。

### 預排版快捷鍵

雙擊頁面上的文字即可在原位置編輯，橫排與直排均保留現有字型、字級、描邊及旋轉。Enter 換行（直排向左另起一欄），點擊外面或 ⌘／Ctrl＋Enter 完成，Esc 保存並結束編輯；完成的一次編輯可一次撤銷。保存、匯出及切換工作區會先提交原位文字。編輯期間保留中文輸入法、選字與文字複製貼上；右側文字欄仍可使用。

原位編輯直排文字時，←／→ 換到左／右欄，↑／↓ 逐字移動；加 Shift 延伸選字。到達最外側欄不再跳到段首／段尾；長欄換到短欄後返回會恢復原字位，空欄與連續換行也可逐一移動。中文組字及 Option／Alt、⌘／Ctrl 組合鍵保留瀏覽器原有行為。

Safari／WebKit 已知限制：多欄直排的實際插入位置可能正確，但原生游標繪製向下偏移。2026-09-20 以相同字型、文字和程式在 Safari 重現；Chrome 測試頁與正式第 7 頁、300% 縮放下，「和」字後按 ↑ 正確停在「曾」字後。現階段直排原位編輯建議使用 Chrome；重啟後端不會修正 Safari 的繪製問題。參考 [WebKit 286961](https://bugs.webkit.org/show_bug.cgi?id=286961) 與 [310592](https://bugs.webkit.org/show_bug.cgi?id=310592)。

左右對照時，左側每條排版文字右下角常駐目前字級數字，右側偵測文字框右下角顯示計算字級數字，兩側均不加文字前綴；無須選取或懸停，原位編輯時也保持顯示。調整字級會即時更新左側，右側沿用偵測結果；缺少計算值顯示「—」。標示不寫入譯文或 Meo.json。

先點選文字；Shift 點選可多選。Mac 使用 ⌘／Option，Windows 使用 Ctrl／Alt。

| 操作 | 快捷鍵 | 大步調整 |
| --- | --- | --- |
| 移動 | 方向鍵：1 原圖像素 | Shift：10；⌘／Ctrl＋Shift：50 |
| 放大／縮小文字 | ⌘／Ctrl＋＋／－：增減 2（＋也可按 =） | 再加 Option／Alt：增減 10 |
| 逆時針／順時針旋轉 | ⌘／Ctrl＋[／]：1° | 再加 Option／Alt：5° |

選中文字後，左上 − 縮小文字、右上 + 放大文字，每次字級增減 2，Option／Alt 點擊為 10；左下 ↶ 逆時針、右下 ↷ 順時針旋轉，每次 1°，Option／Alt 點擊為 5°。多選時逐條調整所有選取文字。按鈕跟隨選框並保持固定螢幕大小，上方圓點仍可拖曳旋轉。

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

本機 macOS 先複製 `scripts/local.env.example` 為 `var/local/start.env`（或執行 `./scripts/start-local.sh init`）並填入模型與 Python 的絕對路徑，再執行 `make start-local`。腳本會把五項資產連結到 `var/local/prelayout-models`、使用 `COMIC_PRELAYOUT_DEVICE=mps`，並在 `127.0.0.1:6008` 啟動網頁；不啟動 ComfyUI。`var/local/start.env` 不進 Git。停止用 `make stop-local`。此入口不可用於 AutoDL。

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

本機連同預排版／修圖模型一次啟動：

```bash
./scripts/start-local.sh init   # 首次：複製路徑範本
# 編輯 var/local/start.env
make start-local
```

瀏覽器打開 `http://127.0.0.1:6008/#/prelayout`。只改前端時可另開 `npm --prefix frontend run dev`（代理到同一 6008）。首次安裝仍執行：

```bash
npm --prefix frontend install
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
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

## 手塗工作流副本

新增「Flux手塗去字」、「FireRed手塗去字」、「Qwen手塗去字」，使用 ComfyUI 原生遮罩編輯器。原三套生產工作流及網頁批次配置保持不變；使用與部署方式見[手塗工作流說明](workflows/handpaint/README.md)。目前完成結構檢查，GPU 推理驗收待有卡環境執行。

預排版首頁及編輯工具列提供「配套PS腳本」按鈕，可下載 [LabelPlus PS Script ZS 1.8.0](frontend/public/downloads/LabelPlus_Ps_Script_ZS-1.8.0.zip)。此 ZIP 隨前端靜態資產部署，無需 GPU。


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

0.2.8 修正更新與 ComfyUI 重啟在 AutoDL／SeetaCloud 反向代理下的同頁判斷：同頁瀏覽器請求以 `Sec-Fetch-Site` 驗證，舊瀏覽器則核對 `Origin`、`Host` 與 `X-Forwarded-Host`；跨站請求仍拒絕。更新包建置會檢查後端與 runtime 版本一致、HEAD 已建立同版本 Tag 且工作樹乾淨，避免再次發布錯標版本。


### 0.2.3 批量修復計時

批量修復顯示每秒更新的「已運行」，從任務建立起包含準備、模型載入、生成與打包；完成、失敗、放棄時固定「總耗時」。後端保存 finished_at，之後修改其他 metadata 不會延長耗時，舊紀錄使用 updated_at 相容。計時由模擬任務測試驗證，不需要實際執行 ComfyUI；此版作為 0.2.2 → 0.2.3 網頁升級驗收目標。


### 輸出完整性修復（2026-09-17）

ComfyUI 輸出先複製到暫存檔，通過 PNG 完整性與解碼檢查後才發布；流程結束重新同步完整原檔，修復過早複製的副本。比較 PDF 為附加輸出，失敗仍打包圖片與日誌並完成任務，完成訊息保留警告。此修復只需部署後端並重啟 6008，不重啟 ComfyUI。

0.2.4：項目工作台「建立新的修復版本」預設勾選 Flux2 Klein 與 FireRed，Qwen 可自行勾選；舊版批次預設不變。此版本一併包含 PNG 完整性與 PDF 非阻斷修復。

0.2.5：6008 網頁增加 ComfyUI 狀態及手動重啟按鈕。操作保留日誌並核對受管理的 6006 PID，與生成、偵測及升級共用 GPU 互斥；無 GPU 或有任務時拒絕重啟，不自動重跑失敗任務。反覆退出原因仍待定位，此功能是恢復入口。

服務連續失聯時終止批次等待、保存服務日誌並最多自動重啟一次；同一任務恢復次數持久保存，再次失敗由使用者決定。6008 可下載部分結果、手動續跑或明確接受已有候選進入合成；缺少候選會標示，沒有任何候選的待修補頁仍阻止完整導出。手動續跑沿用原任務不可變輸入，只補算缺少／檔案損壞的輸出。


### 0.2.6 新建項目保留上傳 Mask

漫畫修圖項目接受部分頁面的同檔名 Mask；拒絕多餘 Mask、重複檔名與尺寸不一致。新建時只自動檢測缺少 Mask 的頁面，已提供的 Mask（包含全黑）保持不變；全部已有 Mask 時不啟動檢測。檢測未啟動或未完成可按「補充缺少的 Mask」重試；原有明確確認的重新檢測仍可取代圖層。此版只本地測試並發布 GitHub 更新包，未部署遠端、未執行 GPU 推理，無新增模型或依賴。

## 修圖選區回應

第一部分的框選、畫筆和套索以獨立輪廓立即回饋，完成手勢後在瀏覽器背景處理 Mask、填色與左右預覽；可繼續下一筆操作。右圖允許延後，未完成的操作輪廓保留到相應結果顯示。保存和切頁會等待已提交的操作，Esc 只取消尚未提交的手勢。局部視窗使用同一機制。

本改造在 `codex/selection-responsive` 獨立工作樹開發，未部署；不改第三部分候選合成與模型流程。驗證方式與限制見 [選區互動驗證](docs/SELECTION_RESPONSIVENESS.md)。

魔法棒提供預設開啟、會記住偏好的「魔法棒預覽」開關；懸停預覽與正式畫面分開更新，同一位置與參數的點擊重用預覽計算。畫筆提供 1–200 px 大小滑塊與數字输入，`[` 縮小、`]` 放大（每次 4 px），工具列顯示快捷鍵提示。

魔法棒啟用時，`[`／`]` 改為減少／增加容差，每次 1，限制在 0–100；工具列顯示對應提示，容差改變後重新計算懸停預覽。畫筆仍每次調整 4 px；輸入框與 Ctrl／Cmd／Alt 組合不攔截。
