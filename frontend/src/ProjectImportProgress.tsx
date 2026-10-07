import { Progress, Typography } from 'antd'
import type { ProjectUploadProgress } from './project-upload'

function megabytes(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MB` }

export function ProjectImportProgress({ progress }: { progress: ProjectUploadProgress }) {
  const uploading = progress.stage === 'uploading'
  const counted = progress.stage === 'validating' || progress.stage === 'creating' || progress.stage === 'completed'
  const percent = uploading && progress.bytesTotal ? Math.min(100, Math.floor((progress.loaded || 0) / progress.bytesTotal * 100))
    : counted && progress.total ? Math.floor(progress.completed / progress.total * 100) : undefined
  const label = uploading ? '正在上傳圖片與 Mask'
    : progress.stage === 'waiting' ? '上傳已送出，等待伺服器接收並開始處理…'
      : progress.stage === 'validating' ? '正在驗證圖片與 Mask'
        : progress.stage === 'creating' ? '正在建立圖片、縮圖與編輯圖層'
          : progress.stage === 'detecting' ? '項目已建立，正在啟動自動檢測…'
            : progress.stage === 'failed' ? '建立項目失敗' : '項目已建立'
  return <section aria-label="圖片匯入進度" role="status" aria-live="polite">
    <Typography.Text strong>{label}</Typography.Text>
    {percent !== undefined && <Progress percent={percent} status={progress.stage === 'failed' ? 'exception' : 'active'} />}
    <div><Typography.Text type="secondary">{uploading
      ? `${megabytes(progress.loaded || 0)}${progress.bytesTotal ? ` / ${megabytes(progress.bytesTotal)}` : ' 已傳送'}`
      : counted ? `已完成 ${progress.completed} / ${progress.total} ${progress.stage === 'validating' ? '個檔案' : '張圖片'}` : '請稍候'}</Typography.Text></div>
    {progress.filename && <div style={{ overflowWrap: 'anywhere' }}><Typography.Text type="secondary">目前檔案：{progress.filename}</Typography.Text></div>}
    {progress.error && <div><Typography.Text type="danger">{progress.error}</Typography.Text></div>}
  </section>
}
