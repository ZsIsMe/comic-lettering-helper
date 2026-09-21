import { Progress, Tag } from 'antd'
import {
  formatWorkflowSeconds,
  firstTimingText,
  remainingTimingText,
  warmTimingText,
  workflowName,
  workflowStateLabel,
  type WorkflowId,
  type WorkflowProgressMap,
  type WorkflowProgressRecord,
} from './workflow-progress'

function statusColor(progress: WorkflowProgressRecord): string {
  if (progress.state === 'completed') return 'green'
  if (progress.state === 'failed') return 'red'
  if (progress.state === 'abandoned') return 'default'
  if (progress.state === 'running') return 'processing'
  return 'blue'
}

function WorkflowProgressItem({ workflow, progress }: { workflow: WorkflowId; progress?: WorkflowProgressRecord }) {
  if (!progress) {
    return <article className="workflow-progress-item missing">
      <div className="workflow-progress-heading"><strong>{workflowName(workflow)}</strong><Tag>未記錄</Tag></div>
      <p>此歷史任務沒有每流程進度資料。</p>
    </article>
  }
  const percent = progress.total > 0 ? Math.round(progress.completed / progress.total * 100) : 0
  const generatedImages = Math.max(0, progress.completed - progress.passthrough)
  return <article className={`workflow-progress-item ${progress.state}`}>
    <div className="workflow-progress-heading"><strong>{workflowName(workflow)}</strong><Tag color={statusColor(progress)}>{workflowStateLabel(progress.state)}</Tag></div>
    <Progress percent={percent} size="small" />
    <dl className="workflow-progress-metrics">
      <div><dt>完成張數</dt><dd>{progress.completed} / {progress.total}</dd></div>
      <div><dt>首圖耗時（含模型載入）</dt><dd>{firstTimingText(progress)}</dd></div>
      <div><dt>非首圖平均</dt><dd>{warmTimingText(progress)}</dd></div>
      <div><dt>累計耗時</dt><dd>{formatWorkflowSeconds(progress.elapsed_seconds)}</dd></div>
      <div><dt>預計剩餘</dt><dd>{remainingTimingText(progress)}</dd></div>
    </dl>
    <p className="workflow-progress-detail">已生成 {generatedImages} 張 · 全黑 Mask 直通 {progress.passthrough} 張</p>
  </article>
}

export function WorkflowProgressSummary({ workflows, progress }: { workflows: WorkflowId[]; progress?: WorkflowProgressMap }) {
  return <section className="workflow-progress-summary" aria-label="各流程進度">
    {workflows.map(workflow => <WorkflowProgressItem key={workflow} workflow={workflow} progress={progress?.[workflow]} />)}
  </section>
}
