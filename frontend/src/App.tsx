import { useEffect, useMemo, useState } from 'react'
import { DirectoryPicker } from './DirectoryPicker'
import {
  Alert,
  Button,
  Checkbox,
  Col,
  Empty,
  Input,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd'
import type { UploadProps } from 'antd'
import { WorkflowProgressSummary } from './WorkflowProgressSummary'
import { friendlyWorkflowText, workflowName as displayWorkflowName, type WorkflowId, type WorkflowProgressMap } from './workflow-progress'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  PlayCircleFilled,
  StopOutlined,
} from '@ant-design/icons'

const { Title, Text, Paragraph } = Typography

type JobState = 'queued' | 'validating' | 'running' | 'packaging' | 'abandoning' | 'abandoned' | 'completed' | 'failed'

interface Health {
  app: string
  comfy_ready: boolean
  queue_running: boolean
  active_job_id: string | null
  gpu_name: string | null
  gpu_memory_used_mib: number | null
  gpu_memory_total_mib: number | null
  gpu_utilization_percent: number | null
}

interface Job {
  id: string
  name: string
  state: JobState
  workflows: WorkflowId[]
  pair_count: number
  black_mask_count: number
  current_workflow: WorkflowId | null
  completed_in_current: number
  completed_total: number
  total_runs: number
  workflow_progress?: WorkflowProgressMap
  message: string
  error: string | null
  download_ready: boolean
  created_at: string
  updated_at: string
  results: Partial<Record<WorkflowId, string[]>>
  result_directory: string | null
  archive_path: string | null
}

const workflows: Array<{
  value: WorkflowId
  title: string
  note: string
  tone: string
  firstSeconds: number
  warmSeconds: number
}> = [
  { value: 'flux2klein_lanpaint', title: 'Flux2 Klein + LanPaint', note: '4-step 局部修復', tone: 'charcoal', firstSeconds: 48.11, warmSeconds: 17.892 },
  { value: 'firered', title: 'FireRed FP8', note: '線稿與網點修復', tone: 'vermilion', firstSeconds: 105.092, warmSeconds: 24.218 },
  { value: 'qwen2511_lanpaint', title: 'Qwen Image 2.1 INT8', note: 'Mask 補洞及擴張 8px', tone: 'teal', firstSeconds: 66.88, warmSeconds: 38.75 },
]

const ACTIVE_STATES = new Set<JobState>(['queued', 'validating', 'running', 'packaging', 'abandoning'])
const TERMINAL_STATES = new Set<JobState>(['completed', 'failed', 'abandoned'])
const CURRENT_JOB_KEY = 'comic-inpaint-current-job'
const DEFAULT_JOB_NAME = '漫畫修復批次'

function cleanStem(file: File): string {
  const raw = file.webkitRelativePath || file.name
  const base = raw.replaceAll('\\', '/').split('/').pop() || raw
  return base.replace(/\.[^.]+$/, '')
}

function isTopLevelFile(file: File): boolean {
  if (!file.webkitRelativePath) return true
  const parts = file.webkitRelativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length <= 2
}

function selectedFolderName(files: File[]): string | null {
  for (const file of files) {
    const parts = file.webkitRelativePath.replaceAll('\\', '/').split('/').filter(Boolean)
    if (parts.length >= 2) return parts[0]
  }
  return null
}

function uploadProps(
  setFiles: (files: File[]) => void,
  accept: string,
  disabled: boolean,
): UploadProps {
  const allowed = new Set(accept.split(',').map((value) => value.trim().toLowerCase()))
  return {
    multiple: true,
    accept,
    disabled,
    beforeUpload: (_file, batchFiles) => {
      const nextFiles = batchFiles.filter((file) => {
        const suffix = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() || ''
        return isTopLevelFile(file) && !file.name.startsWith('._') && allowed.has(suffix)
      })
      setFiles(nextFiles)
      return Upload.LIST_IGNORE
    },
    showUploadList: false,
  }
}

function workflowName(value: WorkflowId | null): string {
  return value ? displayWorkflowName(value) : '等待中'
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function stateLabel(state: JobState): string {
  const labels: Record<JobState, string> = {
    queued: '排隊中',
    validating: '檢查中',
    running: '運行中',
    packaging: '打包中',
    abandoning: '正在放棄',
    abandoned: '已放棄',
    completed: '已完成',
    failed: '失敗',
  }
  return labels[state]
}

function sshDownloadCommand(archivePath: string): string {
  return `scp -P <SSH端口> root@<SSH地址>:"${archivePath}" .`
}

export default function App() {
  const [modal, modalHolder] = Modal.useModal()
  const [sourceFiles, setSourceFiles] = useState<File[]>([])
  const [maskFiles, setMaskFiles] = useState<File[]>([])
  const [selected, setSelected] = useState<WorkflowId[]>(['flux2klein_lanpaint'])
  const [name, setName] = useState(DEFAULT_JOB_NAME)
  const [setupStep, setSetupStep] = useState(0)
  const [health, setHealth] = useState<Health | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [recentJobs, setRecentJobs] = useState<Job[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())

  const pairing = useMemo(() => {
    const sources = new Set(sourceFiles.map(cleanStem))
    const masks = new Set(maskFiles.map(cleanStem))
    const missingMasks = [...sources].filter((stem) => !masks.has(stem))
    const missingSources = [...masks].filter((stem) => !sources.has(stem))
    return { matched: [...sources].filter((stem) => masks.has(stem)).length, missingMasks, missingSources }
  }, [sourceFiles, maskFiles])

  function selectSourceFiles(files: File[]) {
    setSourceFiles(files)
    const folderName = selectedFolderName(files)
    setName(folderName || (files.length === 1 ? cleanStem(files[0]) : DEFAULT_JOB_NAME))
  }

  useEffect(() => {
    const refresh = async () => {
      try {
        const [healthResponse, jobsResponse] = await Promise.all([fetch('/api/health'), fetch('/api/jobs')])
        const nextHealth: Health | null = healthResponse.ok ? await healthResponse.json() : null
        const nextJobs: Job[] = jobsResponse.ok ? await jobsResponse.json() : []
        if (nextHealth) setHealth(nextHealth)
        if (jobsResponse.ok) {
          setRecentJobs(nextJobs)
          setJob((current) => {
            const active = nextJobs.find((item) => item.id === nextHealth?.active_job_id)
              || nextJobs.find((item) => ACTIVE_STATES.has(item.state))
            if (active) return active
            const currentFresh = current ? nextJobs.find((item) => item.id === current.id) : null
            if (currentFresh) return currentFresh
            const rememberedId = window.localStorage.getItem(CURRENT_JOB_KEY)
            return nextJobs.find((item) => item.id === rememberedId) || current
          })
        }
      } catch {
        setHealth(null)
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!job || TERMINAL_STATES.has(job.state)) return
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/jobs/${job.id}`)
      if (response.ok) setJob(await response.json())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [job])

  useEffect(() => {
    if (!job) return
    window.localStorage.setItem(CURRENT_JOB_KEY, job.id)
  }, [job])

  const processing = Boolean(job && ACTIVE_STATES.has(job.state))

  useEffect(() => {
    setClockNow(Date.now())
    if (!processing) return
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [processing])

  const pairReady = pairing.matched > 0 && pairing.missingMasks.length === 0 && pairing.missingSources.length === 0
  const ready = pairReady && selected.length > 0 && name.trim().length > 0
  const progress = job ? Math.round((job.completed_total / Math.max(1, job.total_runs)) * 100) : 0
  const estimatedSeconds = selected.reduce((total, value) => {
    const item = workflows.find((workflow) => workflow.value === value)
    if (!item || pairing.matched === 0) return total
    return total + item.firstSeconds + Math.max(0, pairing.matched - 1) * item.warmSeconds
  }, 0)
  const elapsedSeconds = job
    ? (TERMINAL_STATES.has(job.state) ? Date.parse(job.updated_at) : clockNow) / 1000 - Date.parse(job.created_at) / 1000
    : 0
  const successfulJobs = recentJobs.filter((item) => item.download_ready && ['completed', 'abandoned'].includes(item.state))

  async function submit() {
    if (!ready) return
    setSubmitting(true)
    try {
      const body = new FormData()
      body.append('name', name)
      body.append('workflows', selected.join(','))
      for (const file of sourceFiles) {
        body.append('source_files', file, file.name)
      }
      for (const file of maskFiles) {
        body.append('mask_files', file, file.name)
      }
      const response = await fetch('/api/jobs', { method: 'POST', body })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || '建立任務失敗')
      setJob(payload)
      message.success('任務已加入單 GPU 隊列')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '建立任務失敗')
    } finally {
      setSubmitting(false)
    }
  }

  async function abandon() {
    if (!job || !ACTIVE_STATES.has(job.state)) return
    const response = await fetch(`/api/jobs/${job.id}/abandon`, { method: 'POST' })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.detail || '放棄任務失敗')
    setJob(payload)
    message.warning('正在停止任務；已完成的圖片會保留')
  }

  function confirmAbandon() {
    modal.confirm({
      title: '確定放棄目前任務？',
      content: '系統會中止目前推理並清除尚未完成的部分；已完成的圖片仍可下載。停止可能需要數秒。',
      okText: '確認放棄',
      cancelText: '繼續運行',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await abandon()
        } catch (error) {
          message.error(error instanceof Error ? error.message : '放棄任務失敗')
          throw error
        }
      },
    })
  }

  function resetSetup() {
    setJob(null)
    setSourceFiles([])
    setMaskFiles([])
    setSelected(['flux2klein_lanpaint'])
    setName(DEFAULT_JOB_NAME)
    setSetupStep(0)
    window.localStorage.removeItem(CURRENT_JOB_KEY)
  }

  return (
    <main className="app-shell">
      {modalHolder}
      <div className="paper-grain" aria-hidden="true" />
      <header className="masthead">
        <div>
          <Text className="eyebrow">AUTODL · COMIC INPAINT</Text>
          <Title level={1}>漫畫去字工作台</Title>
          <Paragraph>利用掩膜对图片进行去字修复，可串行执行Flux,FireRed,Qwen三个工作流，比较结果</Paragraph>
        </div>
        <div className="machine-status" aria-live="polite">
          <span className={`status-dot ${health?.comfy_ready ? 'online' : 'offline'}`} />
          <div>
            <strong>{health?.comfy_ready ? '推理引擎就緒' : '等待推理引擎'}</strong>
            <small>{health?.gpu_name || 'GPU 資訊載入中'}</small>
          </div>
          {health?.gpu_memory_total_mib ? (
            <div className="gpu-meter">
              <span>{Math.round((health.gpu_memory_used_mib || 0) / 1024)} / {Math.round(health.gpu_memory_total_mib / 1024)} GiB</span>
              <Progress
                percent={Math.round(((health.gpu_memory_used_mib || 0) / health.gpu_memory_total_mib) * 100)}
                showInfo={false}
                size="small"
                strokeColor="#da4f2a"
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="workspace-layout">
        <div className="primary-column">
          {job ? (
            <section className="queue-section progress-only">
              <div className="section-heading compact">
                <div><Title level={2}>任務進度</Title><Text>刷新或關閉後重新打開，仍會恢復目前進度</Text></div>
              </div>
              <div className={`job-panel ${job.state}`}>
                <div className="job-title-row">
                  <div>
                    <Tag>{stateLabel(job.state)}</Tag>
                    <Title level={3}>{job.name}</Title>
                  </div>
                  {ACTIVE_STATES.has(job.state) ? <LoadingOutlined spin /> : job.state === 'completed' ? <CheckCircleFilled /> : null}
                </div>
                <Progress percent={progress} strokeColor={{ '0%': '#2d6671', '100%': '#da4f2a' }} />
                <div className="job-meta">
                  <span>{friendlyWorkflowText(job.message)}</span>
                  <span>{workflowName(job.current_workflow)}</span>
                  <span>{job.completed_total} / {job.total_runs} 次</span>
                  <span><ClockCircleOutlined /> 已運行 {formatDuration(elapsedSeconds)}</span>
                </div>
                <WorkflowProgressSummary workflows={job.workflows} progress={job.workflow_progress} />
                {job.error ? <Alert type="error" showIcon message={friendlyWorkflowText(job.error)} /> : null}
                <Space wrap className="job-actions">
                  {(processing || (job.state === 'failed' && job.completed_total > 0)) ? (
                    <Button
                      href={job.completed_total > 0 ? `/api/jobs/${job.id}/download-current` : undefined}
                      disabled={job.completed_total === 0}
                      icon={<DownloadOutlined />}
                    >
                      {job.completed_total > 0 ? '下載目前已完成結果' : '尚無完成結果'}
                    </Button>
                  ) : job.download_ready ? (
                    <Button href={`/api/jobs/${job.id}/download`} icon={<DownloadOutlined />} type="primary">下載全部結果</Button>
                  ) : null}
                  {job.state === 'failed' && <Button onClick={() => modal.confirm({ title: '續跑未完成圖片？', content: '保留已完成結果，使用原任務輸入。請先確認 ComfyUI 已就緒。', onOk: async () => {
                    const response = await fetch(`/api/jobs/${job.id}/resume`, { method: 'POST' })
                    const data = await response.json()
                    if (!response.ok) throw new Error(data.detail || '無法續跑')
                    setJob(data)
                  } })}>續跑未完成圖片</Button>}
                  {processing ? (
                    <Button danger icon={<StopOutlined />} loading={job.state === 'abandoning'} onClick={confirmAbandon}>
                      放棄任務
                    </Button>
                  ) : (
                    <Button onClick={resetSetup}>建立新任務</Button>
                  )}
                </Space>
                {job.result_directory ? (
                  <div className="server-location">
                    <Text strong>服務器結果目錄</Text>
                    <code>{job.result_directory}</code>
                    {job.download_ready && job.archive_path ? <code>{job.archive_path}</code> : null}
                  </div>
                ) : null}
              </div>
            </section>
          ) : (
            <section className="wizard-shell">
              <Steps
                className="wizard-steps"
                current={setupStep}
                responsive={false}
                items={[{ title: '圖片與 Mask' }, { title: '修復流程' }, { title: '任務名稱' }]}
              />

              {setupStep === 0 ? (
                <div className="workbench wizard-step">
                  <div className="section-heading">
                    <span className="step-no">01</span>
                    <div><Title level={2}>放入原圖與 Mask</Title><Text>可选多图或者文件夹，不会选择子文件夹。</Text></div>
                  </div>
                  <Row gutter={[20, 20]}>
                    <Col xs={24} lg={12}>
                      <div className="upload-choice">
                        <DirectoryPicker onSelect={(files, folderName) => { selectSourceFiles(files); setName(folderName) }} className="shallow-folder source-drop">
                          <FolderOpenOutlined />
                          <strong>選擇原圖文件夾</strong>
                          <span>可选多图或者文件夹，不会选择子文件夹。</span>
                        </DirectoryPicker>
                        <Upload {...uploadProps(selectSourceFiles, '.png,.jpg,.jpeg', false)}>
                          <Button block>或選擇多張原圖</Button>
                        </Upload>
                      </div>
                    </Col>
                    <Col xs={24} lg={12}>
                      <div className="upload-choice">
                        <DirectoryPicker mask onSelect={setMaskFiles} className="shallow-folder mask-drop">
                          <CloudUploadOutlined />
                          <strong>選擇黑白 Mask 文件夾</strong>
                          <span>可选多图或者文件夹，不会选择子文件夹。</span>
                        </DirectoryPicker>
                        <Upload {...uploadProps(setMaskFiles, '.png', false)}>
                          <Button block>或選擇多張 Mask</Button>
                        </Upload>
                      </div>
                    </Col>
                  </Row>
                  <div className={`pair-strip ${pairReady ? 'valid' : ''}`}>
                    <CheckCircleFilled />
                    <span>成功配對 <b>{pairing.matched}</b> 組</span>
                    {(pairing.missingMasks.length > 0 || pairing.missingSources.length > 0) && (
                      <Text type="danger">缺 Mask {pairing.missingMasks.length} · 缺原圖 {pairing.missingSources.length}</Text>
                    )}
                  </div>
                  <div className="wizard-actions end">
                    <Button type="primary" disabled={!pairReady} onClick={() => setSetupStep(1)}>
                      下一步：選擇修復流程 <ArrowRightOutlined />
                    </Button>
                  </div>
                </div>
              ) : setupStep === 1 ? (
                <div className="workflow-section wizard-step">
                  <div className="section-heading">
                    <span className="step-no">02</span>
                    <div><Title level={2}>選擇修復流程</Title><Text>依序运行，避免时间过长，可不选择全部的工作流。</Text></div>
                  </div>
                  <Checkbox.Group value={selected} onChange={(values) => setSelected(values as WorkflowId[])} className="workflow-grid">
                    {workflows.map((item, index) => (
                      <label className={`workflow-card ${item.tone}`} key={item.value}>
                        <Checkbox value={item.value} />
                        <span className="workflow-index">0{index + 1}</span>
                        <strong>{item.title}</strong>
                        <small>{item.note}</small>
                        <small className="timing-note">首次（含載入）約 {Math.round(item.firstSeconds)} 秒 · 後續約 {Math.round(item.warmSeconds)} 秒／張</small>
                      </label>
                    ))}
                  </Checkbox.Group>
                  <div className="estimate-strip">
                    <ClockCircleOutlined />
                    <span>依 2026-09-09 RTX 4080 SUPER 32GB 實測：本次保守預估約 {formatDuration(estimatedSeconds)}</span>
                  </div>
                  <div className="wizard-actions">
                    <Button icon={<ArrowLeftOutlined />} onClick={() => setSetupStep(0)}>上一步</Button>
                    <Button type="primary" disabled={selected.length === 0} onClick={() => setSetupStep(2)}>
                      下一步：任務名稱 <ArrowRightOutlined />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="naming-section wizard-step">
                  <div className="section-heading">
                    <span className="step-no">03</span>
                    <div><Title level={2}>設定任務名稱</Title><Text>文件夾模式已自動填入原圖文件夾名</Text></div>
                  </div>
                  <label className="name-field">
                    <Text strong>任務名稱</Text>
                    <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} aria-label="任務名稱" />
                    <Text type="secondary">提交時會自動加上時間戳，例如：{name || DEFAULT_JOB_NAME}_0911_221530</Text>
                  </label>
                  <div className="launch-summary">
                    <span><b>{pairing.matched}</b> 組圖片</span>
                    <span>{selected.map((value) => workflowName(value)).join('、')}</span>
                    <span>預估 {formatDuration(estimatedSeconds)}</span>
                  </div>
                  <div className="wizard-actions">
                    <Button icon={<ArrowLeftOutlined />} onClick={() => setSetupStep(1)}>上一步</Button>
                    <Button type="primary" size="large" icon={<PlayCircleFilled />} disabled={!ready || !health?.comfy_ready} loading={submitting} onClick={submit}>
                      開始批量修復
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="history-section">
          <Title level={3}>歷史漫畫修復批次</Title>
          <Text className="history-subtitle">完成結果保留在服務器</Text>
          <Alert
            className="jupyter-tip"
            type="info"
            showIcon
            message="大文件優先使用 SSH／SFTP"
            description="浏览器很慢时，使用下方服务器路径；JupyterLab 可作为备用。"
          />
          {successfulJobs.length ? (
            <List
              dataSource={successfulJobs}
              pagination={successfulJobs.length > 8 ? { pageSize: 8, hideOnSinglePage: true } : false}
              renderItem={(item) => (
                <List.Item actions={item.download_ready ? [processing ? <Text key="download" disabled>任務運行中</Text> : <a key="download" href={`/api/jobs/${item.id}/download`}>下載</a>] : []}>
                  <List.Item.Meta
                    title={item.name}
                    description={(
                      <div className="history-description">
                        <span>{item.pair_count} 組 · {friendlyWorkflowText(item.message)}</span>
                        {item.archive_path ? <code>{item.archive_path}</code> : null}
                        {item.archive_path ? <code>{sshDownloadCommand(item.archive_path)}</code> : null}
                        <span>JupyterLab：進入 comic-inpaint/jobs/對應任務，下載 download.zip。</span>
                      </div>
                    )}
                  />
                  <Tag color={item.state === 'completed' ? 'green' : 'default'}>{stateLabel(item.state)}</Tag>
                </List.Item>
              )}
            />
          ) : recentJobs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚無可下載的完成結果" /> : <Spin size="small" />}
        </aside>
      </div>

      <footer><Space split={<span>·</span>}><span>單 GPU 安全隊列</span><span>自動 RGBA</span><span>全黑 Mask 直通</span><span>完成後輸出 PDF</span></Space></footer>
    </main>
  )
}
