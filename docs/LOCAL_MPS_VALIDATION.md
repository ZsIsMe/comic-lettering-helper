# 本機模型與雙畫布驗證

2026-09-12，分支 `codex/project-workbench`。此記錄為本機驗證，未部署，不代表 AutoDL CUDA 驗收通過。

## 真實模型執行

- 使用已有 Python 3.14.6 arm64 / PyTorch 2.13.0 環境與既有權重；沒有下載、複製模型進 Git 或修改該環境。
- RF-DETR 權重 161,292,684 bytes；MangaLens 權重 12,003,405 bytes。實際 SHA-256 與 `config/detection-models.json` 一致。
- 測試輸入：一張 1080×1536 的 `01.jpg`。另建測試項目，沒有修改來源圖片或使用者原有 21 頁項目。
- 明確指定 `mps`，RF 與 MangaLens 均在 Apple GPU 執行；PyTorch MPS 操作級 CPU fallback 關閉。
- 完成 check → RF → MangaLens → CPU 分類 → 修訂發布，總計約 19.3 秒。RF 載入 3.128 秒、單頁 3.127 秒；MangaLens 載入 0.800 秒、單頁 2.095 秒；分類 2.704 秒。其餘時間包括 Python 啟動、匯入、驗證和編排。
- RF 階段後 MPS driver allocation 約 3205 MiB；MangaLens 約 1084 MiB。這是當時的 Apple 共享記憶體配置量，不是峰值或 CUDA VRAM。
- 已保存 overlay、other、edited 與 detected_text；完整項目封存後匯入 16008 本機工作台，可重新開啟查看。偵測按鈕顯示 MPS。

原生 `showDirectoryPicker` 的授權取消是另一個瀏覽器問題；此次模型驗證由 HTTP API 提交，不宣稱已修复原生文件夾對話框。

## 畫布恢復

左側為可編輯的 Mask／原圖，預設混合 70%，提供 0% 原圖與 100% 黑底 Mask。右側使用即時編輯圖層顯示填色及可調透明度、顏色的待修補標記。顯示參數不修改導出資料。保留原圖座標與雙側同步視角。

瀏覽器合成樣本驗證：F2 繪製在兩邊顯示待修補標記，F1 繪製右邊顯示實際白色填充；切至 0% 時左圖恢復原圖，撤銷 F1 後右圖恢復底圖。真實模型項目匯入後，左側能顯示偵測文字範圍，右側顯示填色結果。

原 GUI 的黄色背景取樣提示及 PS 外擴圈尚未移植；沒有把整塊填色當成偵測文字範圍。

## 自動檢查與界限

- 後端：77 passed，涵蓋装置選擇、不可用装置不回退、非 CUDA 不連 ComfyUI、偵測文字修訂與封存，以及既有項目／合成測試。
- 前端：7 passed，涵蓋兩種非遞歸讀取、預覽端點、即時圖層變化與顯示／導出分離。
- lint、正式 build、diff check 通過；Vite 主 bundle 大小提示仍存在。
- 尚未測試：真實 CPU 推理、完整 21 頁偵測批次、CUDA／ComfyUI 模型切換。未修改三套修復工作流。

目前主服務 `127.0.0.1:16008` 使用原 `var/local/` 項目資料；本機模型配置也位於此 Git 忽略目錄。模型與獨立 Python 由配置引用，正式部署不依赖本機參考工程路徑。
