# AutoDL 部署與重建手冊

預排版左右字級標示只顯示數字，不加「目前」或「計算」前綴；缺少數值時仍顯示「—」。

直排方向鍵及換行位置修正只涉及前端；本機驗收涵蓋不等長欄、最外欄邊界、連續換行、原生 Enter 後保存／重開。重建後在已開啟的頁面按 ⌘R 重新載入。`make start-local` 不會刷新瀏覽器已有分頁。

Safari／WebKit 已知限制：多欄直排的實際插入位置可能正確，但原生游標繪製向下偏移。2026-09-20 以相同字型、文字和程式在 Safari 重現；Chrome 測試頁與正式第 7 頁、300% 縮放下，「和」字後按 ↑ 正確停在「曾」字後。現階段直排原位編輯建議使用 Chrome；重啟後端不會修正 Safari 的繪製問題。參考 [WebKit 286961](https://bugs.webkit.org/show_bug.cgi?id=286961) 與 [310592](https://bugs.webkit.org/show_bug.cgi?id=310592)。

2026-09-20 原位文字編輯：Esc 改為保存並結束編輯，與 ⌘／Ctrl＋Enter 使用同一保存路徑；中文組字期間不攔截 Esc。預排版雙擊橫排／直排文字可直接輸入。這是前端變更，重新執行 `npm --prefix frontend run build` 後刷新本機頁面即可使用，不需要模型或後端資料遷移。尚未同步遠端；遠端更新仍依本文既有部署程序。

新工作台的新建項目使用標準資料夾輸入與多圖輸入，不依賴 `showDirectoryPicker`，配合單一匯入選單。瀏覽器可能枚舉子目錄，但只匯入第一層圖片；拖放資料夾則不枚舉子目錄。舊版批次的資料夾按鈕仍需安全上下文及 File System Access 支援，可改用拖入或多圖。部署後檢查原圖／可選 Mask 選取、第一層過濾與取消行為；確認編輯頁只顯示「自動檢測」，沒有外部 Mask 匯入。此次為靜態頁變更，不需重啟模型服務。

**2026-09-12 狀態：**新的項目工作台、第一／第三部分畫布及封存功能已完成本機實作整合，尚未部署到 AutoDL、未建立新 Tag／鏡像；RF＋MangaLens CUDA 與切換顯存仍待真實 GPU 驗收。不要把下面保留的三工作流歷史基線，或本機 CPU 測試，視為新偵測環境已可發布。

目前程式和資料契約見 [ARCHITECTURE.md](ARCHITECTURE.md)，需求基線見 [PROJECT_WORKBENCH_PLAN.md](PROJECT_WORKBENCH_PLAN.md)，偵測配置及已知依賴例外見 [DETECTION_MODELS.md](DETECTION_MODELS.md)。

本機測試可由 `COMIC_DETECTION_CONFIG` 指向未提交的配置，明確設 `device: "mps"` 或 `"cpu"`，並設定已有的模型路徑與 `COMIC_DETECTION_PYTHON`。不需要安裝 ComfyUI 才能測第一部分；正式 AutoDL 配置維持 `cuda:0`。更新第一部分雙畫布或模型装置支援後，先建置前端，再重啟本機服務以載入配置；保留原 `COMIC_DATA_ROOT`，不清除試用項目。Apple Silicon 可先複製 `scripts/local.env.example` 為 `var/local/start.env`，再執行 `make start-local`。該入口只綁定 `127.0.0.1:6008`、使用 `var/` 與 `mps`，不執行 `deploy/start-web.sh`，也不啟動 6006。

這份文件同時服務兩種情境，請先確認自己走哪一條路：

- **一般使用者：使用已發佈鏡像。** 鏡像內已包含 ComfyUI、三套正式工作流、依賴與 Web 應用；開機後直接打開 Web 頁面，不需要從零安裝。
- **維護者：從零重建或更新鏡像。** 需要重新核對模型來源、ComfyUI／節點版本、工作流、批次器與 GPU 回歸結果，再保存成新的 AutoDL 鏡像。

兩者不要混在一起。一般使用者不應執行從零安裝、拉取最新節點或改動模型連結。

## 新項目工作台：更新後的使用入口

本節描述本次程式更新後的介面，**不是既有遠端鏡像已更新的聲明**。6008 首頁是項目列表；每個項目必須先有原圖，可同時匯入 Mask。從項目進入「準備與編輯／批量修復／比較合成」，亦可由首頁「舊版批次與歷史」使用下節保留的原三步向導。

- 已有同名 Mask：建立項目後直接進第二部分，不要求先裝偵測模型。提交以不可變底圖＋Mask 快照執行，後續編輯不改變已提交輸入。
- 準備與編輯：筆刷／矩形、純色填充、待修補範圍、擦除、縮放／平移、撤銷／重做和自動保存；可單獨下載配對。RF＋MangaLens 需維護者另外配置權重與獨立 Python。
- 比較合成：只讀本項目完成任務的候選；同步比較、局部或整組採用、恢復底圖、保存來源分配與逐頁確認。羽化以保存後的伺服器預覽及導出為準。只需候選時，可跳過此步下載原第二部分結果。
- 導出項目：穩定保存點打包原圖、編輯、快照、候選及合成記錄；重新匯入分配新 ID，不覆蓋原項目、不恢復 GPU 任務。只導出成品則僅含確認後的 PNG。
- 刪除：先顯示名稱及用量並確認；活動任務／下載期間不能刪除。僅移除該項目和它擁有的 jobs，不影響舊版獨立任務或模型。

項目保存在 `<COMIC_DATA_ROOT>/projects/`，修復任務仍在 `jobs/`。關閉網頁不會刪掉保存內容。全黑 Mask 頁沿用提交底圖；整批全黑不等待 ComfyUI，不載入修復模型，也不建立空比較 PDF。無卡模式可以使用項目管理、畫布、已有候選的合成，以及全黑整批直通；不能執行 RF／MangaLens 或非空修補 GPU 推理。

## A. 既有批次版鏡像：一般使用者啟動即用

### 1. 選擇機型並開機

正式三工作流以單張 32 GB GPU 為目標。已驗證的機器是 RTX 4080 SUPER 32 GB；Qwen 和 Flux 的峰值分別達 31,505 MiB 和 31,699 MiB，顯存餘量很小。不要把「可在這張 32 GB 卡跑通」推廣成任意較小顯存卡也可用。

AutoDL 的無卡模式只適合查看文件、安裝 Web 依賴、核對磁碟和盤點模型／節點，**不能做 ComfyUI GPU 推理或三工作流驗證**。

### 2. 打開使用者頁面

鏡像啟動腳本應同時啟動：

- ComfyUI：`0.0.0.0:6006`，保留為 AutoDL `WebUI-6006` 原生調試入口；後端仍在本機用 `127.0.0.1:6006` 連接；
- 漫畫去字工作台：`0.0.0.0:6008`，作為 AutoDL 自定義服務對外入口。

在 AutoDL 控制台打開映射到 6008 的服務地址。非全黑的修復批次需要 Web 與 ComfyUI 均就緒；新版工作台的項目編輯和整批全黑直通不依賴 ComfyUI 可用。

若需要手動管理服務，使用倉庫的統一入口：

```bash
cd /root/comic-inpaint
./deploy/start.sh
./deploy/health-check.sh
```

無卡模式若只想預覽 6008 網站，不啟動 ComfyUI，可單獨執行 `./deploy/start-web.sh`；舊版頁面會顯示「等待推理引擎」，此時不能執行 GPU 推理；新版工作台仍可操作項目與 CPU 畫布。正式有卡使用執行 `start.sh`，它會依序啟動 6006 與 6008。

在 AutoDL 實例的「設定開機命令」中保存以下命令，之後由該實例製作的發行鏡像便可在有卡開機後自動啟動兩個入口：

```bash
bash /root/comic-inpaint/deploy/autodl-start.sh
```

`autodl-start.sh` 會分別嘗試啟動 6008 網站與 6006 ComfyUI；即使其中一項失敗，另一項仍會被嘗試。每次開機結果會追加到 `/root/autodl-tmp/comic-inpaint/logs/startup.log`，便於判斷開機命令是否真正執行，以及哪個服務啟動失敗。手動管理仍使用 `start.sh`，可直接在終端看到結果。

`install-app.sh` 以 root 執行時也會把同一入口安裝為 `/etc/autodl.sh`。這是鏡像內的後備入口：AutoDL 的容器開機程序會嘗試執行該文件，即使控制台沒有在本次開機正確注入自定義命令，鏡像仍能啟動服務。控制台命令與 `/etc/autodl.sh` 最終使用相同、可重複執行的啟動邏輯，不會因此建立第二套 ComfyUI。

不要另外在不同端口重複啟動第二套 ComfyUI。停止本應用時使用：

```bash
cd /root/comic-inpaint
./deploy/stop.sh
```

### 3. 提交批次（新版首頁的「舊版批次與歷史」入口）

1. 在第一步選擇原圖與黑白 Mask。兩邊均可選整個文件夾，或一次多選若干圖片。
2. 確認頁數配對無誤，再進入第二步選擇工作流；預設只選 Flux2 Klein，三套全選時會生成比較 PDF。實際串行順序為 Flux、FireRed、Qwen。
3. 第三步輸入任務名稱。選擇原圖文件夾時會自動帶入文件夾名，提交時再追加 `_月日_時分秒`，例如 `第89話_0911_221530`。
4. 提交後設定向導會隱藏，頁面只顯示進度、目前結果下載及經警告確認的放棄按鈕。等待完成後下載一個 ZIP。

文件以 stem 配對，例如 `001.jpg` 對 `001.png`。文件夾模式只讀取第一層圖片並忽略子文件夾；文件夾或多選圖片模式再次選擇都會整批取代上一次選擇，不會累加。Mask 必須是 PNG，尺寸與原圖相同。使用者不需要製作 Qwen RGBA；後端會把原圖 RGB 與 Mask 轉成節點 168 所需的透明 Alpha。

多張圖片和多套模型會串行運行。瀏覽器顯示的「批量」不是同時把多張圖片塞進顯存；關閉或刷新頁面不會取消後端任務，重新打開後會恢復目前進度。任務運行時鎖定其他輸入，只能下載已完成結果或經警告確認後放棄任務。

### 4. 下載結果

完整三工作流下載包的預期結構是：

```text
inpaint_workflows/firered/
inpaint_workflows/qwen2511_lanpaint/
inpaint_workflows/flux2klein_lanpaint/
inpaint_workflows/<批次名>-三工作流對比.pdf
logs/
```

全黑 Mask 對應頁面會沿用當次底圖（舊版直接提交時為該次原圖），結果文件數仍完整，但比較 PDF 不包含該頁；新版整批全黑不生成空 PDF。

成功與已放棄但有結果的任務會保留在網站列表以及 `/root/autodl-tmp/comic-inpaint/jobs/<job-id>/`。6008 與 JupyterLab 都經過瀏覽器代理，大文件下載可能很慢；優先從 AutoDL 控制台取得 SSH 地址與端口，使用 `scp`、FileZilla 或 WinSCP 走 SFTP 下載網站顯示的 `download.zip` 完整路徑。2026-09-11 在參考實例上，同一張約 4 MB 圖片的 SSH 實測約為 1.44 MB/s，而當時瀏覽器代理只有十幾 KB/s；此數字只反映當次線路。JupyterLab 文件欄下載保留為備用方式。

### 5. 常見狀態

- **Web 可打開但 ComfyUI 未就緒**：先看健康檢查與 ComfyUI 日誌，不要重複提交任務。
- **任務長時間停在第一張**：大型模型冷載入可能暫時阻塞 ComfyUI HTTP；批次器會繼續輪詢。先查 GPU 和日誌，不要中途重啟服務。
- **輸入配對失敗**：檢查 stem、重複文件名、Mask PNG 和尺寸，不要靠文件夾排序修正。
- **顯存不足**：確認沒有其他 GPU 進程，也沒有並行啟動第二個任務或第二套 ComfyUI。

## B. 從零重建：維護者手冊

### 1. 重建原則

從零重建的目標不是「安裝最新版本」，而是重現一組經過 GPU 實測的相容環境。任何以下變更都視為環境變更，需要重新測試：

- ComfyUI、Python、PyTorch 或 CUDA 組合；
- 任一 custom node 或其 Python 依賴；
- 模型／LoRA／文本編碼器／VAE 文件；
- 工作流 JSON；
- LanPaint RGBA、裁切拼接或批次輸入邏輯。

不要僅依工作流 JSON 的節點 metadata 猜測實際安裝版本，也不要為求方便直接拉取 custom node 的最新分支。

### 2. 已驗證基線

2026-09-09 的成功基線如下：

| 項目 | 已驗證值 |
|---|---|
| 實例 | `pro-788873e1ad26` |
| GPU | NVIDIA GeForce RTX 4080 SUPER |
| 可見顯存 | 32,760 MiB |
| ComfyUI | 0.34.0 |
| Python | 3.12.3 |
| PyTorch | 2.8.0+cu128 |
| comfy-cli | 1.20.0 |
| 顯存模式 | NORMAL_VRAM |
| Attention | PyTorch attention |
| Async weight offloading | 開啟，2 streams |
| Pinned memory | 開啟 |

當時 PyTorch 為 CUDA 12.8，ComfyUI 日誌提示 `comfy_kitchen` 的 CUDA/Triton 優化後端未啟用並建議 CUDA 13.0 或以上。該次測試沒有升級，因為目的在驗證鏡像原狀；重建時若升級 CUDA／PyTorch，必須把它當成新基線重新回歸，而不能沿用上述性能結論。

### 3. 鎖定組件版本

2026-09-11 已從參考鏡像完成實際盤點。完整來源、commit、目錄樹 SHA256 及三份工作流 JSON SHA256 以 [`config/components.json`](../config/components.json) 為唯一版本記錄；本文只列易讀摘要：

| 組件 | 已驗證版本／修訂 | 安裝形態 |
|---|---|---|
| ComfyUI-Inpaint-CropAndStitch | 3.0.14 | 參考鏡像內的 archive；以 tree SHA256 鎖定 |
| LanPaint | 2.1.0 | `LanPaint-2.1.0.zip`；以 tree SHA256 鎖定 |
| ComfyUI-KJNodes | commit `6c996e1` | Git |
| rgthree-comfy | commit `2c5342a` | Git |
| ComfyUI-Easy-Use | 1.4.1 | 參考鏡像內的 archive；以 tree SHA256 鎖定 |
| ComfyUI_LayerStyle | Gitee commit `b1b7a6c` | Git |

短 commit 只方便閱讀；安裝和驗證必須使用 `config/components.json` 中的完整值。對 archive 安裝，版本號相同仍不足以證明內容相同，必須核對整個節點目錄的 tree SHA256。LanPaint 的已驗證來源是本地 archive，不能用名稱相近的 Git 倉庫替代。

每次建立新基線或在釋放／覆蓋參考鏡像以前，仍應用無卡模式完成只讀盤點：

- 保存 `ComfyUI/custom_nodes` 的目錄清單；
- 對 Git 安裝的節點記錄 remote URL、commit SHA 和 dirty 狀態；
- 對非 Git／ZIP 安裝的節點記錄來源包、版本文件及整個目錄校驗摘要；
- 記錄 ComfyUI 本體版本、Python 版本和依賴鎖定清單；
- 核對每個模型符號連結的最終來源、文件大小與可取得的 SHA256。

無卡模式可以做這些盤點與安裝，但不能完成最後的 GPU 驗證。新加入而尚未取證的組件不得在文件或設定中虛構為已鎖定版本。

### 4. 準備文件系統

建議固定以下布局：

```text
/root/ComfyUI/                         # ComfyUI 與 custom nodes
/root/comic-inpaint/                   # 本倉庫發行內容
/root/autodl-tmp/comic-inpaint/jobs/   # 使用者修復任務、候選與日誌
/root/autodl-tmp/comic-inpaint/projects/ # 原圖、編輯修訂、快照、合成及封存
```

更新程式時只傳送已建置的前端、後端、配置與發行腳本；不要直接複製含 `var/`、`projects/`、`jobs/`、封存或使用者圖片的整個開發目錄。保留現有 `COMIC_DATA_ROOT`，不要用程式同步覆蓋伺服器資料。新資料結構依 project/job ID 分開保存，不要求遷移既有獨立 jobs。

部署前檢查系統盤與資料盤可用空間。2026-09-11 參考實例在無卡模式下的 `/root/ComfyUI` 所在環境顯示約 30 GB、已用 6.6 GB、可用 23 GB；這只是當時快照，不是最低硬盤需求。公共模型庫或其他掛載的佔用方式可能不同，應以當前實例的實際掛載與模型文件大小重新計算。

應用程式預設放到 `/root/comic-inpaint`。安裝入口負責建立 Python 虛擬環境、安裝後端依賴、構建前端和建立資料目錄。參考鏡像沒有預裝 Node.js，因此正式發行包應帶上已通過本地建置的 `frontend/dist`；腳本在有 npm 時會重新構建，沒有 npm 時使用該預構建版本：

```bash
cd /root/comic-inpaint
./deploy/install-app.sh
```

環境變數以 `.env.example` 為基礎，不把密鑰寫進 `.env`：

```bash
COMIC_APP_ROOT=/root/comic-inpaint
COMFY_ROOT=/root/ComfyUI
COMFY_URL=http://127.0.0.1:6006
COMFY_LISTEN=0.0.0.0
APP_PYTHON=/root/miniconda3/bin/python
COMIC_DATA_ROOT=/root/autodl-tmp/comic-inpaint
COMIC_WEB_HOST=0.0.0.0
COMIC_WEB_PORT=6008
COMIC_MAX_UPLOAD_MB=2048
```

### 5. 安裝 ComfyUI 與 custom nodes

1. 安裝與基線一致的 ComfyUI、Python、PyTorch/CUDA 組合。
2. 按盤點記錄安裝六個 custom nodes 的精確版本。
3. 安裝各節點在該版本聲明的依賴。
4. 把 `workflows/` 的三份正式 JSON 複製到 `/root/ComfyUI/user/default/workflows/`。
5. 不改動提示詞、採樣步數、CFG、LoRA 和 crop/stitch 參數。

LanPaint、CropAndStitch 與 Easy-Use 的參考鏡像內容不是以可 checkout 的 Git commit 鎖定。必須取得已驗證的同一 archive／目錄內容並通過 tree SHA256；只有版本文字相同不能替代內容校驗。若 archive 不在重建材料中，重建在此處視為被依賴來源阻塞，應先從受信任的發佈材料補齊，不能自行換成最新版本。

### 6. 準備模型連結

模型目標與已使用的來源候選記錄在 `config/models.json`。當前清單包括：

| 類別 | 目標文件名 |
|---|---|
| FireRed 主模型 | `diffusion_models/FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors` |
| FireRed Lightning LoRA | `loras/FireRed-Image-Edit-1.1-Lightning-8steps-v1.2.safetensors` |
| Qwen 2511 主模型 | `diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors` |
| Qwen Lightning LoRA | `loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` |
| Qwen 2.5 VL 文本編碼器 | `text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors` |
| Qwen Image VAE | `vae/qwen_image_vae.safetensors` |
| Flux2 Klein 9B FP8 | `diffusion_models/flux-2-klein-9b-fp8.safetensors` |
| Qwen3 文本編碼器 | `text_encoders/qwen_3_8b_fp8mixed.safetensors` |
| Flux2 VAE | `vae/flux2-vae.safetensors` |

執行模型準備工具前，先確認每個 `source_candidates` 在當前 AutoDL 環境中是實際文件。公共庫的物件路徑是已驗證實例的記錄，不保證在另一個地區、鏡像或帳戶中永遠相同；不存在時應停止並補充正確來源，不要建立失效連結，也不要悄悄下載另一個同名模型。

```bash
cd /root/comic-inpaint
/root/miniconda3/bin/python deploy/setup-models.py --comfy-root /root/ComfyUI
# 確認 PLAN 與來源無誤後才建立缺少的連結
/root/miniconda3/bin/python deploy/setup-models.py --comfy-root /root/ComfyUI --apply
```

目前工具會檢查來源候選、既有目標、失效連結及指向不同來源的衝突；預設只顯示計畫，只有 `--apply` 會建立缺少的連結。模型準備必須遵守：

- 先建立 `models/diffusion_models`、`models/loras`、`models/text_encoders`、`models/vae`；
- 同名普通文件存在時不覆蓋；
- 同名符號連結指向不同來源時不覆蓋；
- 建立後另以最終解析路徑、文件大小及已知校驗值驗證；工具會核對設定中的測試文件大小，已提供 SHA256 的文件再由 `verify.py` 核對；
- 目前只有 FireRed Lightning LoRA 在設定中記錄了已知 SHA256；其他文件沒有可靠 SHA256 時必須明確顯示「未提供」，不能偽造成功校驗。

### 6a. 可選 RF／MangaLens 偵測環境

本步新增第一部分偵測能力，不替代前節的三工作流模型準備。權重由使用者或維護者上傳；應用不下載。`config/detection-models.json` 記錄兩個模型的來源、預設路徑與參考 SHA-256；可用 `COMIC_RF_MODEL` 和 `COMIC_MANGALENS_MODEL` 覆寫路径。預設目標如下：

```text
/root/autodl-tmp/models/koharu-layout-rfdetr-seg-2xl-1152/model.safetensors
/root/autodl-tmp/models/mangalens.pt
```

另建偵測專用 Python 3.12 環境，按 [DETECTION_MODELS.md](DETECTION_MODELS.md) 的候選依賴及明示例外安裝，再把 `COMIC_DETECTION_PYTHON` 設為其 Python 絕對路徑。`requirements-detection.txt` 不是已通過 CUDA 驗證的完整鎖定檔：RF-DETR 與 supervision 的 pyDeprecate metadata 存在已知衝突，文件記錄了參考環境採用的獨立 `--no-deps` RF 安裝方式。不要把這套依賴裝進 ComfyUI 或 Web 的 `.venv`，也不要無聲更改原三流程環境。

例如，完成獨立環境準備後，可在啟動配置中設定：

```bash
COMIC_DETECTION_PYTHON=/root/comic-detection-venv/bin/python
COMIC_DETECTION_CONFIG=/root/comic-inpaint/config/detection-models.json
```

未設 Python、缺權重或配置不符時，`GET /api/detection/availability` 顯示原因；只有偵測按鈕不可用。此端點的 `available` 只代表基本檔案準備，不代表 CUDA 已驗證；真正工作進程還要核對權重雜湊、全部頁面輸入、CUDA 及可用顯存。

偵測和修復共用 GPU gate。偵測開始前檢查 ComfyUI 無外部工作並卸載閒置模型，然後依次運行全批 RF、全批 MangaLens、CPU 分類。不要在偵測保留期間手工向 6006 提交工作，也不要為清顯存重啟 ComfyUI。偵測的取消會等待子進程退出；重啟後仍有舊程序時會阻擋新 GPU 任務，待程序退出後使用恢復操作。

### 7. 靜態預檢（無卡可做）

在啟動 GPU 前執行部署檢查：

```bash
cd /root/comic-inpaint
/root/miniconda3/bin/python deploy/verify.py --comfy-root /root/ComfyUI
```

目前 `verify.py` 自動確認：

- ComfyUI 主程序和前端構建入口存在；
- 六個 custom node 目錄存在，Git 安裝核對 commit，archive 安裝核對可重現的目錄 tree SHA256；
- 倉庫內與 ComfyUI 內三份工作流的 SHA256 均符合 `config/components.json`；
- 九個模型目標都能解析到存在的普通文件。

節點 Python 依賴、ComfyUI input/output 可寫性、端口占用、Git dirty 狀態與敏感資料掃描目前不在 `verify.py` 的自動範圍，維護者仍需按本手冊逐項人工核對。

靜態預檢通過只表示相應的原第二部分文件準備完整，不表示三套模型能成功推理，也不驗證 RF／MangaLens CUDA 環境。新偵測環境另按前節與偵測模型文件檢查。

### 8. GPU 回歸測試

從零重建必須開 GPU 完成實際測試。因為模型、節點或環境已變更，先各用一組非全黑 Mask 做一次 smoke test；通過後再運行預定的完整測試批次。對已建立且未變更的正式鏡像，日常批次則不需要每次先跑 smoke test。

測試必須遵循：

- 先驗證全部 source/Mask 的 stem、尺寸與 Mask 方向；
- Qwen 走 `qwenlanpaint` 路徑生成 RGBA，不把獨立 Mask 直接送節點 168；
- 三套工作流串行運行；
- 每套工作流一次跑完所有待處理頁，再切換模型；
- 每秒採樣顯存，保存 CSV、摘要、批次器與 ComfyUI 日誌；
- 以輸出文件數與預期 stem 逐一核對成功，不只看退出碼；
- 不對 Qwen 輸出做內容分數、自動篩選或拒絕。

已驗證基線的兩頁結果是 2/2、2/2、2/2 成功，三套監控時段合計 303.223 秒，無 OOM。新的回歸結果應另建帶日期的記錄，不覆寫舊基線。

新增工作台還須完成以下針對性驗收；不因原第二部分曾經成功，就跳過新增輸入及排程邊界：

- 權重到位後，先一頁 RF＋MangaLens CUDA smoke test，再小批次確認原尺寸文字／氣泡分割、分類與人工 edited 保護。
- 核對全批模型順序、子進程退出、載入／推理耗時與顯存；確認偵測→ComfyUI 修復，以及修復→偵測切換不並行佔卡。
- 從項目 Mask 直入及第一部分輸出各建立快照，按受影響流程測試配對與 Qwen Alpha 規則；全黑整批應在 ComfyUI 未啟動時仍完整輸出。
- 以完成候選驗收第三部分局部來源、尺寸拒絕、羽化伺服器預覽與成品一致；確認未確認／缺頁不被標為完整成品。
- 封存移到另一資料目錄再匯入，重開編輯及合成；測試活動任務／下載時刪除受阻，以及舊版 jobs 仍可讀取下載。

上述新工作台的目標 GPU 與遠端集成驗收在本次本機實作階段尚未完成。

### 9. 比較 PDF 與交付驗證

三套工作流全部完成後，在遠端主機直接生成比較 PDF，並與圖片、日誌一起打成單一下載包。PDF 欄位順序固定為原圖 + Mask、Flux、FireRed、Qwen；全黑 Mask 頁面省略。

原第二部分的候選結果交付包只包含：

- 實際選中的 `inpaint_workflows/<workflow>/`；
- 三套全選時的比較 PDF；
- 獨立頂層 `logs/`。

不要把 `raw_*`、ComfyUI 臨時輸入或任務中間工作流混入結果目錄。

完整項目封存和最終成品 ZIP 是另外兩種下載：完整項目可包含原圖、修訂、快照、候選與合成來源；只導出成品只含全部已確認 PNG。不要用原候選包的清单限制完整項目封存，也不要把候選 ZIP 說成最終人工成品。

### 10. 發佈前清理與保存鏡像

先確認沒有活動修復／偵測／下載，且必要項目和結果已另存，再停止兩個應用服務並查看清理計畫：

```bash
cd /root/comic-inpaint
./deploy/stop.sh
./deploy/prepublish-clean.sh
```

新版清理計畫必須涵蓋本應用的 **projects／jobs／logs／run**、`web_*` ComfyUI 暫存和 Qwen RGBA 暫存。projects 內含原圖、人工編輯、快照、偵測快取、候選引用、合成與封存；不能只清 jobs 就保存公開鏡像。先核對實際清單及資料根目錄，確認必要資料已取回、列出的目標確實可刪，再明確套用：

```bash
./deploy/prepublish-clean.sh --apply
```

清理完成後再次執行靜態預檢，並確認：

- 沒有 AutoDL Token、SSH 密鑰、密碼或 API Key；
- 沒有使用者項目、原圖、人工編輯、快照、偵測快取、成品／候選、完整封存、比較 PDF、顯存／ComfyUI 日誌；
- 沒有 macOS `._*` 文件；
- 正式工作流、批次器、前端構建、後端依賴與模型連結仍完整；若發布第一部分偵測，另確認獨立偵測環境及上傳權重仍完整；
- 啟動腳本保持 6006 為原生 ComfyUI、6008 為批量網站；
- 實例處於乾淨、停止服務的狀態，再在 AutoDL 控制台保存鏡像。

公開鏡像不是把本地 Docker Image 推給 AutoDL，而是從已配置並清理過的 AutoDL 實例保存。公共模型應盡量保留為平台公共庫的有效符號連結，避免把可共享的大模型重複烘焙進系統盤；本地自有且無公共來源的模型／LoRA 則必須確認發佈授權與存放位置。

## C. 發佈後維護

- 每個發佈版本記錄鏡像 ID、日期、硬件、ComfyUI／Python／PyTorch、custom node 精確版本、模型校驗和與回歸批次。
- 版本升級在新實例中完成，不直接破壞唯一的已驗證鏡像。
- 更新前以 `/api/health` 確認 `active_job_id` 與 `gpu_owner` 都為空，並核對沒有活動項目操作；只更新 Web 程式時先完成 lint／build／後端測試，再同步已建置 `frontend/dist` 和確定 commit 的程式，以 `deploy/restart-web.sh` 只重啟 6008，確認 6006 PID 未改變。
- 若只修改 Web UI 且不影響輸入與批次器，可做 API／介面回歸；若觸及工作流、節點、模型或格式轉換，按受影響邊界做真實 GPU 回歸。新增 RF／MangaLens 不能沿用三修復模型的歷史結論，須独立驗收並測試共享 GPU 切換。
- 若 AutoDL 公共庫路徑失效，先更新來源映射並驗證實際文件，再建立新鏡像版本；不要在使用者啟動時臨時下載數十 GB 模型。
- 保留每次成功基線的測試報告，速度比較始終分開記錄冷載入與暖機推理。

React 19 的確認視窗使用受控 Modal 或 Modal.useModal。更新前端構建後應檢查刪除視窗能開啟及取消；不需重啟後端或模型服務。

第一部分工具更新只需重新構建前端；不更改權重或執行 GPU。部署後檢查矩形／畫筆操作、魔法棒四種模式與預覽、套索 Enter／Esc、右鍵與 Cmd／Ctrl＋右鍵、局部範圍套用／取消／撤銷。長按拖曳使用 Pointer Capture，瀏覽器畫布右鍵選單停用。局部視窗先保存副本，只有套用後主頁才保存到伺服器；詳見 [EDITOR_TOOLS.md](EDITOR_TOOLS.md)。

工具列整理後須檢查 F1／F2 常駐按鈕、重新開頁保留選擇與互換提示；分別確認 F1／F2 下同一框內的純色填充與待修補 Mask 互換結果一致，空白和框外不變；互換僅由 Cmd／Ctrl＋右鍵拖框觸發，沒有按鈕或 F12 綁定。仍只更新靜態前端，不重啟模型。


### 氣泡分類及重新檢測驗收

需同時更新前端與後端。重啟 Web 服務前確認 `/api/health` 沒有 active job／GPU owner；保留原資料目錄和偵測環境。確認自動檢測彈窗顯示項目名稱、全部頁數、覆蓋人工修改與匯入 Mask，取消不提交，確認送 `replace_existing: true`。舊項目不在升級時自動重新分類或執行模型。

分類同步已通過真實第 2 頁快取對照及純影像測試；未更換 RF／MangaLens 權重、依賴、推理參數或三套修復工作流。這不是新的 AutoDL CUDA 驗收。使用者要套用新分類時，可在頁面確認後重跑自動檢測。

### 自動檢測設定驗收（2026-09-12）

需同步更新後端與前端，Web 重啟前確認沒有執行中的任務。新建視窗的圖片匯入區下方應顯示四項設定；建立時依「建立後立即自動檢測」選擇啟動模型或只保存設定。重新開啟項目後，檢測視窗應帶回設定，並在同一視窗提示覆蓋範圍；取消不得提交。匯出／重新匯入項目應保留設定。關閉氣泡辨識後，缺少 MangaLens 不應阻擋 RF；既有裝置選擇仍由伺服器配置決定。


## 預排版部署準備

頁碼導覽位於頂部工具列下方，橫向排列並自動換行，不佔左側欄位；頁數較多時導覽區最高佔視窗 25%，其餘頁碼可在區內捲動。既有點頁跳轉、目前頁高亮、連續捲動與顯示切換邏輯保留。

「上傳去字圖」目前只隱藏前端入口，底層 API 與既有圖片保留。此介面調整只需更新前端構建，不需重啟後端或重新生成底圖。

原圖對照改為左編輯、右原圖；單字框提示需要本次前後端一起更新。舊偵測資料的 `page-characters/` 快取由首次頁面讀取建立，不須重新跑模型；服務帳號須能寫入預排版資料目錄。驗收單字框座標與縮放、W／H／FS、hover 不修改文字、關閉偵測框及多頁連續捲動。

文字快捷鍵更新只需重建前端，不增加模型、Python 依賴或資料遷移。先執行 `npm --prefix frontend run test:prelayout-shortcuts`、lint、build 及既有後端測試；同步前端後在目標瀏覽器人工確認方向鍵 1／10／50 px、字級 2／10、旋轉 1°／5°、Option／Alt 符號鍵與滾輪、多選差值、輸入框／組字避讓、長按撤銷及普通上下捲動；選框上方字級按鈕須確認增減 2／10，下方旋轉按鈕須確認 1°／5°，並檢查多選、縮放後點擊大小及不誤觸拖曳。離線邏輯測試不代表各平台瀏覽器的原生保留鍵已驗收。

預排版排版輸出只提供 `Meo.json`，不提供項目 ZIP 匯出或 `/export/archive` API。更新後確認頂部僅有「匯出 Meo.json」，下載前完成保存；關閉及重新開啟網頁仍從伺服器恢復原有項目。既有封存匯入保留相容性，修圖模組的匯出行為不受此設定影響。

偵測任務另自動生成 OpenCV `inpainted` 預覽，無需新增權重或先上傳去字圖。驗收須包括 RGBA 覆蓋層與原圖合成、空白頁原樣保留、全批底圖完成後才發布、文字修訂不變，以及分級預覽讀取。舊任務沒有此產物時沿用原圖或已上傳底圖，重新偵測後取得生成預覽；此變更不啟動 ComfyUI 修圖流程。

本地模型測試與鏡像驗收分開：可用工程外已有 CTD／OCR、字型及 Python，Apple Silicon 明確設定 `COMIC_PRELAYOUT_DEVICE=mps`，執行 `prelayout_core.check --device mps` 後，透過網頁 API 測試完整流程。這種模式保持 GPU 任務互斥，不需要啟動 CUDA ComfyUI，也不會自動回退 CPU。鏡像使用預設 `COMIC_PRELAYOUT_DEVICE=cuda`，仍須完成下列 CUDA 和顯存交接驗收；本地 MPS 結果不能代替。資產清單及設定集中於 [README](../README.md#預排版模型與配套資產)。

本節是本地開發完成後的準備清單，尚未在 AutoDL 執行。預排版與圖片修復共用 6008 服務，模型與資料各自位於工程外。模型資產、來源、精確雜湊和環境變數以 [README 的預排版區塊](../README.md#預排版模型與配套資產)為準。

1. 確認本地工作樹驗證結果，依使用者的發布安排選定 `codex/prelayout-web` 的明確 commit；本次僅本地提交，未推送或部署。發行內容使用該 commit 的原始碼與成功構建的 `frontend/dist`，不要直接同步整個開發目錄。排除 `.venv`、`node_modules`、`var-test`、測試圖片、報告、日誌及模型；保留核心來源授權文件。
2. 將 README 列出的五項資產直接上傳到 `/root/models/comic-prelayout`，不經 Git。保留所用模型、字型的來源授權材料。單字框偵測只要求 CTD；要提供預設 OCR 字級功能，必須準備全部五項。
3. 在 `/root/comic-prelayout-venv` 建立隔離環境。先按 [PyTorch 官方安裝說明](https://pytorch.org/get-started/locally/)選擇與目標驅動／Python 相容的 CUDA PyTorch 和 torchvision，再安裝 `backend/requirements-prelayout.txt`。這份檔案是本機 macOS 來源版本記錄，目標 Linux wheel 或依賴不相容時需在此隔離環境調整並重新驗證，不能改 ComfyUI 環境或宣稱已具備可重建的 CUDA 鎖定組合。系統須提供 `ps`／程序群組信號能力。
4. 在服務 `.env` 設定三個 `COMIC_PRELAYOUT_*` 變數；資料根預設 `/root/autodl-tmp/comic-inpaint/prelayout`。確認服務帳號可讀模型與字型、執行外部 Python、寫入預排版資料目錄。不要使用修圖 projects／jobs 目錄作預排版根目錄。
5. 執行 README 的 `prelayout_core.check --require-cuda`；必須同時通過五項資產雜湊、核心依賴、字型指標與 CUDA。再執行既有 `deploy/verify.py` 檢查 ComfyUI／工作流資源。兩個工具責任不同，都不是實際推理成功證據。
6. 同步程式前讀取 `/api/health`，確認 `active_job_id`、`gpu_owner` 都為空，並確認沒有活動預排版工作／下載。Web 更新只用 `deploy/restart-web.sh`，核對 6008 回應與新前端資產，確認 6006 PID 沒有改變。
7. 在新環境先以一頁真實漫畫做 CTD＋OCR smoke test，再測兩種字級方法及含無文字頁的多頁批次。保存任務日誌，核對全部頁面、量測位置、字級、顏色、方向與 BT 匹配，測試重新偵測不覆蓋人工排版。
8. 驗收預排版偵測 → 修復 → 預排版偵測、RF／MangaLens → 預排版的互斥與切換；記錄 CUDA、顯存、模型載入與階段耗時。測試取消、worker 異常退出和 Web 重啟，確認子程序退出後才允許下一個 GPU 任務。不要在此期間繞過應用向 6006 手動提交。
9. 在 6008 真實瀏覽器測試連續捲動、移動／旋轉、固定字型、弱網保存與封存重開。完成後保存 Python／pip／CUDA 環境清單、資產雜湊和測試報告，再按發行流程決定 Tag／鏡像。

發布公開鏡像前，先取回使用者資料，停止服務並執行清理預覽。`deploy/prepublish_clean.py` 現在也列出預排版 `projects/`、`preferences/` 和暫存 `prelayout-*.zip`，不刪除外置模型；自訂資料根使用同一個 `COMIC_PRELAYOUT_DATA_ROOT` 或 `--prelayout-root`。此腳本不自動載入 `.env`，需在執行環境提供實際資料根，核對列出的精確路徑後才按既有規則 `--apply`。本次只以臨時合成資料測試清理契約，未清理任何使用者或遠端資料。

若 GPU／CUDA 驗收尚未完成，仍可部署供測試的人工預排版介面並保持模型功能不可用；不能將該狀態發布為「CTD／OCR 已可用」的完整鏡像。
## 邊緣塗白頁面

本功能沿用單一 6008 FastAPI 服務，無需新增模型、Swift 環境、GPU 任務或對外端口。部署需包含新增的 `backend/app/edgewhite*.py`、`backend/imaging/edgewhite.py` 及完整前端正式建置；建置會產生獨立 `guide-snap.worker-*.js`，不可只更新主 JS 而遺漏 Worker。

資料目錄新增 `<COMIC_DATA_ROOT>/edgewhite/`，應可持久寫入，並納入備份與發布前的使用者資料清理範圍。原件、草稿與輸出皆屬使用者資料，不能帶入公開鏡像。不要將本機測試目錄或來源 Mac 工程路徑部署上線。

一般資料夾選取使用瀏覽器支援的目錄 API；不支援時用拖入資料夾或多選圖片。讀取只到第一層，不使用 `webkitdirectory`。反向代理須允許既有 `/api/*`、multipart 請求及靜態 Worker 資產。Hash 路由不需要額外服務端 SPA 路徑回退。

這次僅完成本機開發；實際部署仍須按既有規範先檢查 GPU 空閒、建置成功，僅重啟 6008，並驗證 6006 未受影響。


### 2026-09-12 匯入入口修訂（取代此前非遞歸選取器方案）

使用者已允許瀏覽器掃描子目錄。新建集合改為單一匯入區：點擊唯一匯入區後，在選單選擇「多張圖片」或「單個資料夾」，也可直接拖入；資料夾模式使用標準 `input webkitdirectory`，不再呼叫 `showDirectoryPicker`。瀏覽器可列舉子目錄，應用只匯入第一層圖片，避免包含 deal 成品。因瀏覽器原生檔案選擇器區分圖片多選及目錄模式，兩種模式由同一入口的選單選取，不再有獨立資料夾按鈕。

內建瀏覽器實測：經資料夾選擇器指定第 82 話目錄，顯示 21 張並略過 1 個子資料夾；點擊主區開啟多選選擇器，選入 2 張測試圖片成功。此前 showDirectoryPicker 的阻塞不再適用於新版入口。lint、build、18 項前端及 61 項後端測試通過。

## 三個工作區合併（2026-09-12）

`codex/prelayout-web`（8cdc3c7）及 `codex/edgewhite-web`（74b4ec8）合入 `codex/project-workbench`。修圖仍為預設入口，首頁增加預排版和邊緣塗白；三部分沒有強制前後依賴。統一的 hash 路由在離開編輯頁前保存，失敗則留在原頁。修圖頁保持掛載並在隱藏時禁止互動，返回時保留原圖片與步驟；附加模組按需載入。

資料分別位於 `<COMIC_DATA_ROOT>/projects`、`prelayout`、`edgewhite`，API 使用獨立路徑；合併不搬移其他工作樹的試用資料。預排版自訂根目錄不得重疊修圖、jobs 或 edgewhite。CTD／OCR 與修圖偵測／ComfyUI 共用 ResourceGate，程序恢復時保留全部仍存活的佔用。原修圖工作流、批次器、輸入轉換與合成核心未改。

整合驗收：前端 lint／build 與 58 項測試通過；後端 194 項測試通過。隔離瀏覽器使用合成圖片驗證三個入口與編輯頁、預排版文字修改跨模組返回後仍保存、返回修圖仍停在批量修復步驟。三個 API 清單各只包含自己的測試項目；無 GPU 任務。`make verify-local` 的倉庫工作流與前端通過，本機 /root/ComfyUI 缺 19 項外部環境；未做新的 CUDA 驗收。

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

平台代理可將公開 `Origin` 轉送至不同的內部 `Host`。更新與 ComfyUI 重啟以瀏覽器 `Sec-Fetch-Site: same-origin` 判斷同頁請求；舊瀏覽器則需代理保留 `X-Forwarded-Host`。部署後應從實際公開 WebUI 網址各測一次更新提交與 ComfyUI 重啟入口，跨站 Origin 測試仍須回傳 403。

發布 0.2.8 起，先同步 `backend/app/updates.py` 與 `config/runtime.json` 的版本並提交，再建立同版本 Tag，最後在乾淨工作樹執行 `deploy/build-update.py`；任一條件不符時建置器會停止。Git Tag 本身不足以供網頁升級，必須建立 GitHub Release 並上傳 `application.zip` 與 `application.zip.sha256`。


### 0.2.3 批量修復計時

批量修復顯示每秒更新的「已運行」，從任務建立起包含準備、模型載入、生成與打包；完成、失敗、放棄時固定「總耗時」。後端保存 finished_at，之後修改其他 metadata 不會延長耗時，舊紀錄使用 updated_at 相容。計時由模擬任務測試驗證，不需要實際執行 ComfyUI；此版作為 0.2.2 → 0.2.3 網頁升級驗收目標。


### 輸出完整性修復（2026-09-17）

ComfyUI 輸出先複製到暫存檔，通過 PNG 完整性與解碼檢查後才發布；流程結束重新同步完整原檔，修復過早複製的副本。比較 PDF 為附加輸出，失敗仍打包圖片與日誌並完成任務，完成訊息保留警告。此修復只需部署後端並重啟 6008，不重啟 ComfyUI。

0.2.4：項目工作台「建立新的修復版本」預設勾選 Flux2 Klein 與 FireRed，Qwen 可自行勾選；舊版批次預設不變。此版本一併包含 PNG 完整性與 PDF 非阻斷修復。

0.2.5：6008 網頁增加 ComfyUI 狀態及手動重啟按鈕。操作保留日誌並核對受管理的 6006 PID，與生成、偵測及升級共用 GPU 互斥；無 GPU 或有任務時拒絕重啟，不自動重跑失敗任務。反覆退出原因仍待定位，此功能是恢復入口。

服務連續失聯時終止批次等待、保存服務日誌並最多自動重啟一次；同一任務恢復次數持久保存，再次失敗由使用者決定。6008 可下載部分結果、手動續跑或明確接受已有候選進入合成；缺少候選會標示，沒有任何候選的待修補頁仍阻止完整導出。手動續跑沿用原任務不可變輸入，只補算缺少／檔案損壞的輸出。


### 0.2.6 新建項目保留上傳 Mask

漫畫修圖項目接受部分頁面的同檔名 Mask；拒絕多餘 Mask、重複檔名與尺寸不一致。新建時只自動檢測缺少 Mask 的頁面，已提供的 Mask（包含全黑）保持不變；全部已有 Mask 時不啟動檢測。檢測未啟動或未完成可按「補充缺少的 Mask」重試；原有明確確認的重新檢測仍可取代圖層。此版只本地測試並發布 GitHub 更新包，未部署遠端、未執行 GPU 推理，無新增模型或依賴。

僅修改「OCR 對齊逐字計算」：CTD 階段同時計算並保留既有單字框字級（相同基準／步長），OCR 校準後取 max（單字框字級，OCR 字級）。measure 保留 font_size_char_box、font_size_ocr 及各自方法，最終方法為 max_char_box_ocr_aligned；缺少可靠 OCR 時保留單字框結果，無可靠單字框時沿用原回退／OCR 結果。OCR 跨行同字的字框 IoU ≥ 0.8 時保留較完整的可靠字框，重複樣本標記 duplicate_overlapping_character 後再做原有 MAD 篩選。獨立「單字框計算」算法保持不變。 更新後新啟動的偵測 worker 會載入新算法；既有 measure 與逐頁快取不自動改寫，需重新偵測才能在介面取得新計算值。

## 修圖選區 Worker 資產

選區改造的正式前端構建會額外產生 `raster-worker-*.js`。部署時同步完整 `frontend/dist/`，包含 Worker chunk；代理和 CSP 必須允許同源 module Worker，Worker URL 必須回傳 JavaScript 而不是 SPA HTML。瀏覽器需支援 Worker 內 OffscreenCanvas 2D、transferToImageBitmap 與 convertToBlob；不支援時顯示錯誤，不回退到阻塞主執行緒的像素計算。本版不使用 SharedArrayBuffer，因此無須為此增加 COOP／COEP 標頭。

發布前在實際代理 URL 和目標瀏覽器檢查載入、框選、畫筆、魔法棒、撤銷、保存與重開；本機驗證不能代替 AutoDL 代理驗收。此分支尚未部署，沒有新增 GPU 或後端依賴。

選區驗收補充：檢查魔法棒預覽開關、快速移動／離開不殘留舊預覽，正式選區不被懸停取消；檢查畫筆大小滑塊及 `[`／`]`。本機測試頁人工延遲預設 0 ms；勾選「模擬慢速回覆（1 秒）」只用於隔離壓力測試，日常試用請關閉。

魔法棒啟用時，`[`／`]` 改為減少／增加容差，每次 1，限制在 0–100；工具列顯示對應提示，容差改變後重新計算懸停預覽。畫筆仍每次調整 4 px；輸入框與 Ctrl／Cmd／Alt 組合不攔截。

第二輪回歸增加：快速 hover 後立即點擊、舊預覽取消、局部 patch 經撤銷／重做／保存重開後仍與全圖一致；切換顯示比例／顏色應觸發全圖刷新。部署仍只需完整前端 dist（含 Worker），未新增 WASM、GPU 或後端依賴。

原圖預載驗收：第一部分相鄰切頁後確認原圖正確、已保存圖層未回退；前後預載遵守目前篩選結果，快取限 64 MiB，退出項目後清理。檢查矩形、畫筆、魔法棒游標互異且熱點與落筆位置一致。此功能只需完整前端構建，不新增後端服務或 GPU 依賴。

切頁 Worker 重用須與新版主 bundle／Worker chunk 一起部署，保持 init copyInputs 協定一致。驗收包含連續前後切頁只保留一個主 Worker、畫筆後立即切頁先保存、返回筆畫仍在、退出編輯階段釋放 Worker。DEV 測試頁 `tests/page-navigation-browser.html?pageLoadMode=baseline` 保留舊生命週期及複製路徑作 A/B；正式构建不開放 baseline 開關。
