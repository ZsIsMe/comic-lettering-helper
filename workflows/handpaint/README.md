# 手塗去字工作流

這三個 JSON 供 ComfyUI 原生頁面載入：**Flux手塗去字**、**FireRed手塗去字**、**Qwen手塗去字**。

1. 載入對應 JSON，在唯一的原圖節點上傳圖片。
2. 右鍵圖片，開啟遮罩編輯器（Open in MaskEditor），用遮罩筆刷塗出需要修復的區域。
3. 保存遮罩回節點，再執行工作流。更換原圖後重新編輯並保存遮罩。

原圖節點同時輸出 IMAGE 與 MASK：原圖 RGB 保留，塗抹區域 Alpha = 0、MASK = 1。不要以白色畫筆修改原圖 RGB，也不需要上傳獨立黑白 Mask。Qwen 同樣沿用這個 RGBA 輸入契約。

三套副本保留既有模型、提示詞、採樣、LoRA、外擴、裁切及回貼設定。舊工作流、網頁選項和批次器配置不變。這些是原生 ComfyUI 單圖流程，不經網頁批次器；未塗抹時不要執行，這裡沒有批次器的全黑 Mask 直通判斷。

伺服器部署時僅複製本目錄三個 JSON 到 `/root/ComfyUI/user/default/workflows/`，也保存副本於 `/root/comic-inpaint/workflows/handpaint/`。原有三個 JSON 不覆蓋；不需重啟網頁服務。ComfyUI 已開啟的工作流列表可能需要刷新。

結構驗證包含完整連線、單一原圖輸入及原推理參數不變。無卡伺服器不能完成 GPU 推理驗收，需有卡後各做一張非空遮罩測試，才可宣稱生成已通過。
