/* eslint-disable react-refresh/only-export-components -- Isolated preview entry mounts its own root. */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, ConfigProvider, Empty, Image as AntImage, message, Select, Space, Spin, Steps, Tag, Typography } from 'antd'
import zhTW from 'antd/locale/zh_TW'
import { CheckOutlined, PlusOutlined, PictureOutlined } from '@ant-design/icons'
import { ExecutionImagePicker } from '../src/ExecutionImagePicker'
import { addPageToNextRound, executionPageIds, workflowRoundName, type ExecutionSelection } from '../src/execution-selection'
import { RegionComparison } from '../src/RegionComparison'
import { adoptComparisonRegion, type CompareRegion } from '../src/comparison-regions'
import { workflowOptions, type Workflow } from '../src/workbench-api'
import '../src/styles.css'
import './repair-rounds.css'

declare const __ROUNDS_ASSET_ROOT__: string
type Asset = { image: string; diff: string }
type Page = { id: string; filename: string; width: number; height: number; base: string; maskPreview: string; maskReady: boolean; results: Record<string, Asset> }
type Round = { id: string; workflow: Workflow; createdAt: string; pageIds: string[]; assetKey: string; code: number; simulated?: boolean }
type Manifest = { version: number; projectName: string; pages: Page[]; rounds: Omit<Round, 'code'>[] }
type Session = { selection: ExecutionSelection; rounds: Round[]; compared: string[]; assignments: Record<string, number[][]>; workflows: Workflow[] }
type Decoded = { base: ImageData; results: Map<string, { image: ImageData; diff: ImageData }> }
type Candidate = { code: number; label: string; image: ImageData; diff: ImageData }
const assetUrl = (relative: string) => `${__ROUNDS_ASSET_ROOT__}/${relative}`
const nameOf = (round: Round) => workflowRoundName(round.workflow, new Date(round.createdAt))

function initialSession(manifest: Manifest): Session {
  const rounds: Round[] = manifest.rounds.map((round, index) => ({ ...round, code: index + 2 }))
  const first = rounds.find(round => round.workflow === 'flux2klein_lanpaint')
  if (first) rounds.push({ ...first, id: 'demo-second-flux', code: rounds.length + 2,
    createdAt: new Date(new Date(first.createdAt).getTime() + 3600000).toISOString(),
    pageIds: first.pageIds.filter((_, index) => index === 2 || index === 6), simulated: true })
  return { selection: { mode: 'all' }, rounds, compared: rounds.map(round => round.id), assignments: {}, workflows: ['flux2klein_lanpaint', 'firered'] }
}

async function readImage(url: string, width: number, height: number): Promise<ImageData> {
  const image = new Image(); image.src = url; await image.decode()
  if (image.width !== width || image.height !== height) throw new Error('預覽圖片尺寸不一致')
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, width, height)
}

function decodeAssignment(runs: number[][] | undefined, size: number): Uint16Array {
  const values = new Uint16Array(size)
  let offset = 0
  for (const [code, count] of runs || []) { values.fill(code, offset, offset + count); offset += count }
  return values
}
function encodeAssignment(values: Uint16Array): number[][] {
  const runs: number[][] = []
  for (const value of values) {
    const last = runs.at(-1)
    if (last && last[0] === value) last[1]++
    else runs.push([value, 1])
  }
  return runs
}

function composite(base: ImageData, candidates: Candidate[], assignment: Uint16Array): ImageData {
  const output = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
  const sources = new Map(candidates.map(candidate => [candidate.code, candidate.image.data]))
  for (let n = 0; n < assignment.length; n++) {
    const source = sources.get(assignment[n])
    if (source) for (let c = 0; c < 3; c++) output.data[n * 4 + c] = source[n * 4 + c]
  }
  return output
}

function PreviewCanvas({ image }: { image: ImageData }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => { canvas.current?.getContext('2d')?.putImageData(image, 0, 0) }, [image])
  return <canvas ref={canvas} width={image.width} height={image.height} aria-label="目前合成結果" />
}

function Comparison({ page, rounds, selected, runs, onSave, layout }: {
  page: Page; rounds: Round[]; selected: string[]; runs: number[][] | undefined
  onSave: (runs: number[][]) => void; layout: 'multi' | 'context' | 'cards'
}) {
  const [decoded, setDecoded] = useState<Decoded | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void (async () => {
      const base = await readImage(assetUrl(page.base), page.width, page.height)
      const results = await Promise.all(Object.entries(page.results).map(async ([key, asset]) => [key, {
        image: await readImage(assetUrl(asset.image), page.width, page.height), diff: await readImage(assetUrl(asset.diff), page.width, page.height),
      }] as const))
      if (active) setDecoded({ base, results: new Map(results) })
    })().catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [page])
  if (error) return <Alert type="error" message={error} />
  if (!decoded) return <div className="rounds-loading"><Spin /></div>
  const candidates: Candidate[] = rounds.flatMap(round => {
    const data = decoded.results.get(round.assetKey)
    return data && round.pageIds.includes(page.id) ? [{ code: round.code, label: nameOf(round), ...data }] : []
  })
  const visible = rounds.filter(round => selected.includes(round.id))
  const assignment = decodeAssignment(runs, page.width * page.height)
  const output = composite(decoded.base, candidates, assignment)
  const masks = new Map(candidates.map(candidate => [candidate.code, candidate.diff.data]))
  const adopt = (region: CompareRegion, code: number) => onSave(encodeAssignment(adoptComparisonRegion(assignment, page.width, page.height, region, code, masks)))
  const full = { x: 0, y: 0, width: page.width, height: page.height }
  const missing = visible.filter(round => !candidates.some(candidate => candidate.code === round.code))
  return <>
    {!!missing.length && <p className="rounds-missing">{missing.map(round => <Tag key={round.id}>{nameOf(round)}：本輪未生成</Tag>)}</p>}
    {layout === 'multi' ? <div className="rounds-images">
      <section className="rounds-image-card"><div className="rounds-image-heading"><strong>目前合成結果</strong><Button size="small" onClick={() => adopt(full, 1)}>恢復底圖</Button></div><PreviewCanvas image={output} /></section>
      <section className="rounds-image-card"><div className="rounds-image-heading"><strong>原圖＋目前 Mask</strong></div><AntImage src={assetUrl(page.maskPreview)} alt="原圖＋目前 Mask" /></section>
      {visible.map(round => {
        const available = candidates.some(candidate => candidate.code === round.code)
        return <section key={round.id} className="rounds-image-card">
          <div className="rounds-image-heading"><strong>{nameOf(round)}</strong>{round.simulated && <Tag>模擬</Tag>}
            <Button size="small" disabled={!available} onClick={() => adopt(full, round.code)}>採用本頁</Button></div>
          {available ? <AntImage src={assetUrl(page.results[round.assetKey].image)} alt={nameOf(round)} /> : <div className="rounds-absent"><Empty description="本輪未生成這張圖片" /></div>}
        </section>
      })}
    </div> : <RegionComparison key={`${page.id}-${selected.join(',')}-${layout}`} layout={layout} base={decoded.base} preview={output}
      candidates={candidates} visibleCodes={visible.map(round => round.code)} assignment={assignment} disabled={false} onAdopt={adopt} />}
  </>
}

function Workbench({ manifest }: { manifest: Manifest }) {
  const storageKey = `comic-rounds-preview-v1-${manifest.pages[0].id}`
  const [session, setSession] = useState<Session>(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (saved?.rounds?.length && saved?.selection && saved?.assignments && saved?.workflows) return saved } catch { /* Optional local storage. */ }
    return initialSession(manifest)
  })
  const [step, setStep] = useState(1)
  const [pageIndex, setPageIndex] = useState(0)
  const [picker, setPicker] = useState(false)
  const [layout, setLayout] = useState<'multi' | 'context' | 'cards'>('multi')
  const [lastRun, setLastRun] = useState<{ pageIds: string[]; roundNames: string[] } | null>(null)
  const [messages, messageHolder] = message.useMessage()
  const [storageError, setStorageError] = useState('')
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(session)) }
    catch { setStorageError('瀏覽器無法保存預覽狀態；目前操作仍保留在此頁面。') }
  }, [session, storageKey])
  const allIds = manifest.pages.map(page => page.id)
  const selectedIds = executionPageIds(session.selection, allIds)
  const selectedPages = manifest.pages.filter(page => selectedIds.includes(page.id))
  const page = manifest.pages[pageIndex]
  const scope = session.selection.mode === 'all' ? `全部 ${allIds.length} 張` : `已選 ${selectedIds.length} / ${allIds.length} 張`
  const addCurrent = () => {
    const selection = addPageToNextRound(session.selection, page.id, allIds)
    setSession(value => ({ ...value, selection }))
    void messages.success(`${page.filename} 已加入下一輪，目前選中 ${executionPageIds(selection, allIds).length} 張`)
  }
  const simulate = () => {
    const latest = Math.max(0, ...session.rounds.map(round => new Date(round.createdAt).getTime()))
    const date = new Date(Math.max(Date.now(), latest + 1000))
    const newRounds: Round[] = session.workflows.map((workflow, index) => ({
      id: `preview-${crypto.randomUUID()}`, workflow, createdAt: date.toISOString(), pageIds: [...selectedIds],
      assetKey: (manifest.rounds.find(round => round.workflow === workflow) || manifest.rounds[0]).assetKey,
      code: Math.max(1, ...session.rounds.map(round => round.code)) + index + 1, simulated: true,
    }))
    setSession(value => ({ ...value, rounds: [...value.rounds, ...newRounds] }))
    setLastRun({ pageIds: [...selectedIds], roundNames: newRounds.map(nameOf) })
    void messages.success(`已新增 ${newRounds.length} 個模擬輪次；沿用既有預覽圖片，未執行模型。`)
  }
  return <main className="app-shell project-workspace rounds-preview">
    {messageHolder}
    <Alert className="rounds-preview-banner" type="info" showIcon message="本地介面預覽 · 無需 ComfyUI" description="載入本機已有的修圖結果。標記「模擬」的輪次重用示範圖片，只供確認操作流程；此頁不連接生成服務。" />
    {storageError && <Alert type="warning" message={storageError} />}
    <header className="project-header"><div><Typography.Title level={2}>{manifest.projectName.replace('・本地調試（已有結果）', '')}</Typography.Title><Typography.Text type="secondary">{manifest.pages.length} 張圖片 · {session.rounds.length} 個工作流輪次</Typography.Text></div>
      <Space><Tag color="orange">介面草稿</Tag><Button onClick={() => { setSession(initialSession(manifest)); setLastRun(null); void messages.info('已重設本地預覽') }}>重設示範</Button></Space></header>
    <Steps size="small" current={step} onChange={value => setStep(value)} items={[{ title: '準備與編輯', disabled: true }, { title: '批量修復' }, { title: '比較合成', disabled: !session.compared.length }]} />
    {step === 1 ? <div className="rounds-batch">
      <Card title="建立新的修復版本">
        <Checkbox.Group aria-label="選擇工作流" value={session.workflows} options={workflowOptions} onChange={values => setSession(value => ({ ...value, workflows: values as Workflow[] }))} />
        <div className="rounds-execution-row"><div><strong data-testid="execution-scope">執行範圍：{scope}</strong><p>{selectedPages.filter(item => item.maskReady).length} / {selectedPages.length} 張 Mask 已備妥<span className="rounds-latest-mask">使用項目目前的底圖與最新 Mask</span></p></div>
          <Space wrap><Button icon={<PictureOutlined />} onClick={() => setPicker(true)}>選擇執行圖片</Button>
            <Button type="primary" disabled={!selectedIds.length || !session.workflows.length || selectedPages.some(item => !item.maskReady)} onClick={simulate}>開始批量修復（模擬）</Button></Space></div>
        {session.selection.mode === 'pages' && <div className="rounds-selected-names">{selectedPages.map(item => <Tag key={item.id}>{item.filename}</Tag>)}</div>}
      </Card>
      {lastRun && <Alert type="success" showIcon className="rounds-submission" message={`本次模擬提交：${lastRun.pageIds.length} 張圖片，${lastRun.roundNames.length} 個工作流`}
        description={<><div>{lastRun.roundNames.join('、')}</div><p>PDF 範圍：僅本次的 {lastRun.pageIds.length} 張圖片與以上工作流；預覽不製作 PDF。</p></>} />}
      <div className="rounds-history-title"><div><Typography.Title level={4}>工作流輪次</Typography.Title><Typography.Text type="secondary">已選 {session.compared.length} 個輪次</Typography.Text></div><Button type="primary" size="large" className="workbench-next-step" disabled={!session.compared.length} onClick={() => setStep(2)}>前往比較合成 →</Button></div>
      <div className="rounds-history">{[...session.rounds].reverse().map(round => {
        const selected = session.compared.includes(round.id)
        return <div key={round.id} className={`rounds-history-row${selected ? ' selected' : ''}`}><div><strong>{nameOf(round)}</strong>{round.simulated && <Tag>模擬</Tag>}<span>{round.pageIds.length} 張圖片</span></div>
          <Button type={selected ? 'primary' : 'default'} icon={selected ? <CheckOutlined /> : undefined} aria-pressed={selected} aria-label={`${nameOf(round)} ${selected ? '已選中比較' : '加入比較'}`}
            onClick={() => setSession(value => ({ ...value, compared: value.compared.includes(round.id) ? value.compared.filter(id => id !== round.id) : [...value.compared, round.id] }))}>{selected ? '已選中' : '加入比較'}</Button></div>
      })}</div>
    </div> : <div className="rounds-compare">
      <div className="rounds-compare-toolbar"><Space wrap>
        <Button aria-label="上一頁" disabled={!pageIndex} onClick={() => setPageIndex(index => index - 1)}>‹</Button>
        <Select aria-label="選擇合成頁面" value={pageIndex} onChange={setPageIndex} options={manifest.pages.map((item, index) => ({ value: index, label: `${item.filename} · ${index + 1}/${manifest.pages.length}` }))} />
        <Button aria-label="下一頁" disabled={pageIndex === manifest.pages.length - 1} onClick={() => setPageIndex(index => index + 1)}>›</Button>
        <Select aria-label="比較模式" value={layout} onChange={setLayout} options={[{ value: 'multi', label: '多圖對比' }, { value: 'context', label: '整體＋局部' }, { value: 'cards', label: '區域卡片' }]} />
      </Space><Space wrap><Button icon={<PlusOutlined />} onClick={addCurrent}>加入下一輪</Button><Tag data-testid="next-scope">下一輪：{scope}</Tag><Button onClick={() => setStep(1)}>返回批量修復 →</Button></Space></div>
      <div className="rounds-candidate-picker"><strong>比較對象</strong><Select mode="multiple" aria-label="選擇比較工作流輪次" value={session.compared} optionFilterProp="label" maxTagCount="responsive"
        onChange={compared => setSession(value => ({ ...value, compared }))}
        options={session.rounds.map(round => ({ value: round.id, label: `${nameOf(round)}${round.simulated ? ' · 模擬' : ''}` }))} />
        <Button onClick={() => setSession(value => ({ ...value, compared: value.rounds.map(round => round.id) }))}>全部加入比較</Button></div>
      <p className="rounds-compare-help">可同時比較同一工作流的不同輪次。未生成本頁的輪次會標示空缺；加入下一輪後，返回批量修復再開始。</p>
      <Comparison key={page.id} page={page} rounds={session.rounds} selected={session.compared} runs={session.assignments[page.id]} layout={layout}
        onSave={runs => setSession(value => ({ ...value, assignments: { ...value.assignments, [page.id]: runs } }))} />
    </div>}
    {picker && <ExecutionImagePicker pages={manifest.pages.map(item => ({ ...item, maskPreviewUrl: assetUrl(item.maskPreview) }))} value={session.selection}
      onCancel={() => setPicker(false)} onApply={selection => { setSession(value => ({ ...value, selection })); setPicker(false) }} />}
  </main>
}

function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch(assetUrl('manifest.json')).then(async response => {
      if (!response.ok) throw new Error('尚未準備本地預覽圖片，請先執行 scripts/prepare-rounds-preview.py')
      const data: Manifest = await response.json()
      if (!data.pages.length || !data.rounds.length) throw new Error('預覽需要至少一張圖片及一組已保存结果')
      setManifest(data)
    }).catch(reason => setError(String(reason)))
  }, [])
  return <ConfigProvider locale={zhTW} theme={{ token: { colorPrimary: '#da4f2a', colorInfo: '#2d6671', colorSuccess: '#28714b', colorText: '#25231f', colorBgBase: '#f5f1e8', borderRadius: 10, fontFamily: '"PingFang TC", "Microsoft JhengHei", sans-serif' } }}>
    {error ? <Alert type="error" message={error} /> : manifest ? <Workbench manifest={manifest} /> : <div className="rounds-loading"><Spin /></div>}
  </ConfigProvider>
}

createRoot(document.getElementById('root')!).render(<App />)
