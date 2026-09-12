# 獨立模型：用途、下載與部署

修圖、預排版、邊緣塗白有各自的項目與圖片，不要求依序使用。以下四個模型供自動檢測或字級計算使用；人工編輯不需要它們，邊緣塗白完全不需要模型。模型權重不放進本倉庫，部署時另外下載／上傳到工程外目錄。

## 模型一覽

| 模型 | 在本應用的用途 | 使用位置 | 約大小 | 來源與下載 |
| --- | --- | --- | --- | --- |
| Koharu RF-DETR Seg 2XL 1152 | 偵測文字、狀聲詞、氣泡、分格的範圍；產生文字 Mask，供後續分類及人工編輯。模型本身不識別文字內容。 | 修圖 → 自動檢測 | 161 MB | [模型介紹](https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152) · [下載 model.safetensors](https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152/resolve/main/model.safetensors) |
| MangaLens | 取得氣泡輪廓，協助判斷文字在氣泡內外，以及擴展純色填充。關閉氣泡辨識時不載入。 | 修圖 → 自動檢測的氣泡辨識 | 12 MB | [提供模型的專案](https://github.com/hgmzhn/manga-translator-ui) · [模型倉庫](https://www.modelscope.cn/models/hgmzhn/manga-translator-ui) · [下載 mangalens.pt](https://www.modelscope.cn/models/hgmzhn/manga-translator-ui/resolve/master/mangalens.pt) |
| Comic Text Detector（CTD） | 取得漫畫文字區塊和分割結果，供預排版的文字範圍與單字框／字級流程使用。 | 預排版 → 偵測與字級 | 80 MB | [原專案](https://github.com/dmMaze/comic-text-detector) · [上游 Release](https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.2.1) · [下載 comictextdetector.pt](https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.2.1/comictextdetector.pt) |
| mit48px CTC OCR | 對文字區域執行 OCR，配合字表、字型墨跡指標及來源核心計算對齊字級；不負責翻譯。 | 預排版 → OCR 對齊字級 | 169 MB | [模型檔案庫](https://huggingface.co/dreMaz/mit_models/tree/main) · [下載 mit48pxctc_ocr.ckpt](https://huggingface.co/dreMaz/mit_models/resolve/main/mit48pxctc_ocr.ckpt) · [上游 OCR 實作](https://github.com/zyddnys/manga-image-translator/blob/main/manga_translator/ocr/model_48px_ctc.py) |

RF 和 MangaLens 是兩個獨立模型，修圖自動檢測將它們串行使用；CTD 和 OCR 屬於獨立的預排版流程。這些模型不取代第二部分的 FireRed、Qwen Image Edit 2511、Flux2 Klein 修復工作流。原三套修復模型與配套檔案仍見 [模型清單](../config/models.json)及[部署手冊](DEPLOYMENT.md)。

## OCR 配套檔案

| 檔案 | 用途 | 取得方式 |
| --- | --- | --- |
| `alphabet-all-v5.txt` | 與 OCR checkpoint 配套的字表 | 上游 [ocr-ctc.zip](https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/ocr-ctc.zip) 內含此字表；解壓後按下表校驗。其來源宣告見上游 [模型映射](https://github.com/zyddnys/manga-image-translator/blob/main/manga_translator/ocr/model_48px_ctc.py)。不要替換成 v7。 |
| `NotoSansCJKjp-Medium.otf` | 固定預覽字型及字級校準基準 | [Noto CJK 原始庫](https://github.com/notofonts/noto-cjk) · [下載字型](https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Medium.otf)；下載後校驗版本。 |
| `NotoSansCJKjp-Medium.ink-metrics.json` | 上述固定字型與字表的校準產物，並非模型權重 | 使用維護者提供的同版本配套檔；本次本地來源工程的 `assets/fonts/` 已有，且已上傳至伺服器。此檔沒有已核實的獨立公共下載地址，不能從 Noto 字型倉庫取得。原工程的 `tools/generate_font_ink_metrics.py` 可生成指標，但生成結果仍須符合本應用固定校驗值，不能直接以不同平台重算值替代。 |

上游 OCR ZIP 的 checkpoint 名稱是 `ocr-ctc.ckpt`；本應用使用上表另外提供的 `mit48pxctc_ocr.ckpt`。不要只改檔名便假定是相同版本，必須核對 SHA-256。

## 工程外存放位置

此部署採用下列目錄，權重、字型及推理 Python 均不進 Git：

```text
/root/autodl-tmp/models/
├── koharu-layout-rfdetr-seg-2xl-1152/model.safetensors
├── mangalens.pt
└── comic-prelayout/
    ├── comictextdetector.pt
    ├── mit48pxctc_ocr.ckpt
    ├── alphabet-all-v5.txt
    ├── NotoSansCJKjp-Medium.otf
    └── NotoSansCJKjp-Medium.ink-metrics.json
```

服務 `.env`：

```dotenv
COMIC_DETECTION_CONFIG=/root/comic-inpaint/config/detection-models.json
COMIC_DETECTION_PYTHON=/root/comic-detection-venv/bin/python
COMIC_PRELAYOUT_MODEL_ROOT=/root/autodl-tmp/models/comic-prelayout
COMIC_PRELAYOUT_PYTHON=/root/comic-prelayout-venv/bin/python
COMIC_PRELAYOUT_DEVICE=cuda
```

RF／MangaLens 路徑及 `cuda:0` 設備由 [detection-models.json](../config/detection-models.json) 控制。預排版程式未設定模型根時預設 `/root/models/comic-prelayout`，因此使用本頁目錄時須設定 `COMIC_PRELAYOUT_MODEL_ROOT`。圖片與項目另外保存於 `COMIC_DATA_ROOT`，不混入模型目錄。

## 版本與校驗值

2026-09-12 本機與伺服器逐檔校驗一致。RF、OCR 的公開檔案庫 LFS 雜湊亦已核對；MangaLens 和 Noto 字型的下載內容已比對一致。CTD Release 已核對檔名與大小，字表 ZIP 的內容映射已查閱上游程式；下載後仍應逐檔以以下值驗證。

| 相對模型根路徑 | bytes | SHA-256 |
| --- | ---: | --- |
| `koharu-layout-rfdetr-seg-2xl-1152/model.safetensors` | 161292684 | `9bf6d2cbd7793c956d8c857bb1672a396eb7f100eb0682f86830d05e31168efb` |
| `mangalens.pt` | 12003405 | `4028152940f7c910f40192f46ede3b3f6c7129e5c76849c324d3564f8ac50198` |
| `comic-prelayout/comictextdetector.pt` | 79948869 | `1f90fa60aeeb1eb82e2ac1167a66bf139a8a61b8780acd351ead55268540cccb` |
| `comic-prelayout/mit48pxctc_ocr.ckpt` | 169075247 | `8b0837a24da5fde96c23ca47bb7abd590cd5b185c307e348c6e0b7238178ed89` |
| `comic-prelayout/alphabet-all-v5.txt` | 95997 | `c1295ae1962e69e35b5b225a0405d1f3432e368c9941d23bfd3acda12654da33` |
| `comic-prelayout/NotoSansCJKjp-Medium.otf` | 16554004 | `dd523e580e3413c480b2d701bf64e534c20f8419e3cfb6a44c2bdcd8d2a6c052` |
| `comic-prelayout/NotoSansCJKjp-Medium.ink-metrics.json` | 742590 | `29a0af82d3501eab9bf8bb0f8de8294b972927eb7d6e863b7cfd2d165ce28a56` |

Linux 可用 `sha256sum <檔案>`，macOS 可用 `shasum -a 256 <檔案>`。連結中的 main／master 可能更新；雜湊不同時不要直接取代既有權重，應先核對版本。應用在推理前再次檢查固定資產。

## 推理環境與驗收

兩個流程使用各自的 Python 環境；不要把依賴裝進 ComfyUI 或 Web 的 `.venv`。RF 依賴與明示的 pyDeprecate metadata 例外見 [DETECTION_MODELS.md](DETECTION_MODELS.md)；預排版來源依賴見 [requirements-prelayout.txt](../backend/requirements-prelayout.txt)。這份預排版清單源於本機，Linux/CUDA 環境需另外記錄實際安裝版本並驗收。

無卡開機可以上傳、校驗、安裝依賴及載入來源核心；不能據此宣稱 GPU 推理已通過。預排版無卡預檢（不帶 `--require-cuda`，不執行推理）：

```bash
PYTHONPATH=/root/comic-inpaint/backend /root/comic-prelayout-venv/bin/python -m prelayout_core.check --model-root /root/autodl-tmp/models/comic-prelayout
```

有卡開機後才執行帶 `--require-cuda` 的預檢，以及 RF／MangaLens、CTD／OCR 和修復模型之間的顯存交接驗收。所有 GPU 任務共用資源鎖，按階段串行執行，不自動回退 CPU。

## 來源與授權

下載地址不等於本倉庫重新授權權重。請按各上游模型卡／Release 使用模型；RF 模型卡標記自訂授權並說明 Manga109 資料條件，不能將 RF-DETR 程式碼的 Apache-2.0 直接當作權重授權。Noto 字型的授權隨官方字型發行。

本倉庫移植核心的來源與授權分別保存在 [修圖 NOTICE](../backend/imaging/NOTICE.md) 與 [預排版 NOTICE](../backend/prelayout_core/NOTICE.md)。本頁不新增模型檔案至倉庫，也不代表完成公開鏡像發布。
