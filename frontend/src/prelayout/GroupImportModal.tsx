import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Checkbox, Empty, Modal, Select, Space, Table, Tag } from 'antd'
import { base, projectPath, request } from './api'
import { getFontCatalogue, subscribeFontCatalogue } from './font-catalogue'
import { fontFamilyLabel, fontStyleLabel } from './local-fonts'
import { groupNameKey, maxGroupImportBytes, mergeGroupImport, parseGroupImport, type GroupConflict, type GroupImportResult, type ImportedGroup } from './group-import'
import type { Group, Project } from './types'

export type GroupImportModalProps = {
  open: boolean
  currentProjectId: string
  currentGroups: Group[]
  onClose: () => void
  onImport: (result: GroupImportResult) => void
}

export function GroupImportModal({ open, currentProjectId, currentGroups, onClose, onImport }: GroupImportModalProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState('')
  const [sourceId, setSourceId] = useState<string>()
  const [sourceName, setSourceName] = useState('')
  const [sourceGroups, setSourceGroups] = useState<ImportedGroup[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [conflict, setConflict] = useState<GroupConflict>('overwrite')
  const [applyExisting, setApplyExisting] = useState(false)
  const sourceRequest = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const catalogue = useSyncExternalStore(subscribeFontCatalogue, getFontCatalogue)

  useEffect(() => {
    if (!open) return
    let live = true
    const requestState = sourceRequest
    setProjectsLoading(true); setProjectsError('')
    setSourceId(undefined); setSourceName(''); setSourceGroups([]); setSelected([]); setSourceError(''); setSourceLoading(false)
    setConflict('overwrite'); setApplyExisting(false)
    void request<Project[]>(`${base}/projects`).then(value => {
      if (live) setProjects(value.filter(project => project.id !== currentProjectId))
    }).catch(error => { if (live) setProjectsError(error instanceof Error ? error.message : '無法讀取本機項目。') })
      .finally(() => { if (live) setProjectsLoading(false) })
    return () => { live = false; requestState.current++ }
  }, [open, currentProjectId])

  const preview = useMemo(() => {
    try { return { result: mergeGroupImport(currentGroups, sourceGroups, selected, conflict, applyExisting), error: '' } }
    catch (error) { return { result: null, error: error instanceof Error ? error.message : '分組資料無效。' } }
  }, [currentGroups, sourceGroups, selected, conflict, applyExisting])
  const existing = new Map(currentGroups.map((group, index) => [groupNameKey(group.name), index]))
  const rows = sourceGroups.map((group, index) => ({ ...group, index, existing: existing.get(groupNameKey(group.name)) }))

  async function loadSource(name: string, projectId: string | undefined, read: () => Promise<unknown>) {
    const token = ++sourceRequest.current
    setSourceId(projectId); setSourceName(name); setSourceLoading(true); setSourceError(''); setSourceGroups([]); setSelected([])
    try {
      const groups = parseGroupImport(await read())
      if (sourceRequest.current === token) { setSourceGroups(groups); setSelected(groups.map((_, index) => index)) }
    } catch (error) {
      if (sourceRequest.current === token) setSourceError(error instanceof Error ? error.message : '無法讀取來源分組。')
    } finally { if (sourceRequest.current === token) setSourceLoading(false) }
  }

  const matchingSelected = rows.filter(row => selected.includes(row.index) && row.existing !== undefined).length
  return <Modal title="匯入其他項目分組" open={open} width={720} onCancel={onClose} cancelText="取消" okText={`加入整理草稿（${selected.length} 組）`}
    okButtonProps={{ disabled: sourceLoading || !selected.length || !preview.result || !!sourceError }}
    onOk={() => { if (preview.result && selected.length && !sourceLoading && !sourceError) onImport(preview.result) }}>
    <Space wrap style={{ marginBottom: 10, width: '100%' }}>
      <Select aria-label="來源預排版項目" showSearch optionFilterProp="label" placeholder="選擇其他本機項目" value={sourceId} loading={projectsLoading} style={{ width: 300, maxWidth: '100%' }}
        notFoundContent={projectsLoading ? '載入中…' : '沒有其他本機項目'} options={projects.map(project => ({ value: project.id, label: project.name }))}
        onChange={id => { const project = projects.find(value => value.id === id); void loadSource(project?.name || id, id, () => request<Project>(projectPath(id))) }} />
      <Button onClick={() => fileInput.current?.click()}>選擇 Meo.json</Button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
        void loadSource(file.name, undefined, async () => {
          if (file.size > maxGroupImportBytes) throw new Error('JSON 超過 5 MB，請選擇較小的分組來源。')
          const text = await file.text()
          try { return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown } catch { throw new Error('無法解析 JSON，請確認檔案格式。') }
        })
      }} />
    </Space>
    {projectsError && <Alert type="warning" showIcon message={`本機項目列表讀取失敗：${projectsError}`} description="仍可選擇 JSON 檔案。" style={{ marginBottom: 8 }} />}
    <Space wrap style={{ marginBottom: 8 }}>
      <span>同名分組</span><Select aria-label="同名分組處理" value={conflict} style={{ width: 184 }} onChange={setConflict}
        options={[{ value: 'overwrite', label: '覆蓋字體設定（預設）' }, { value: 'keep', label: '保留現有設定' }]} />
      <Checkbox checked={applyExisting} disabled={conflict === 'keep'} onChange={event => setApplyExisting(event.target.checked)}>同時套用到同名分組現有文字</Checkbox>
    </Space>
    {sourceError && <Alert type="error" showIcon message={`來源分組讀取失敗：${sourceError}`} style={{ marginBottom: 8 }} />}
    {preview.error && <Alert type="error" showIcon message={preview.error} style={{ marginBottom: 8 }} />}
    {sourceName && <div style={{ marginBottom: 6, fontSize: 12 }}>來源：{sourceName} · 已選 {selected.length}/{sourceGroups.length} 組{matchingSelected > 0 && ` · 同名 ${matchingSelected} 組`}</div>}
    <Table size="small" rowKey="index" dataSource={rows} loading={sourceLoading} pagination={false} scroll={{ y: 340 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={sourceName ? '來源沒有分組' : '選擇項目或 JSON，預覽後匯入'} /> }}
      rowSelection={{ selectedRowKeys: selected, onChange: keys => setSelected(keys.map(Number)) }}
      columns={[
        { title: '分組', dataIndex: 'name', width: '27%' },
        { title: '字體 · 字重', render: (_, row) => {
          const font = catalogue.fonts.find(value => value.postscriptName === row.font)
          return font ? <span title={font.postscriptName}>{fontFamilyLabel(font)} · {fontStyleLabel(font)}</span>
            : row.font ? <span title={row.font}>{row.font}</span>
              : <span className="pl-muted">{Object.hasOwn(row, 'font') ? '清除分組預設' : '未提供，保留現有字體'}</span>
        } },
        { title: '處理', width: 112, render: (_, row) => row.existing === undefined ? <Tag color="green">新增</Tag>
          : <Tag color={conflict === 'overwrite' ? 'blue' : undefined}>{conflict === 'keep' ? '保留' : Object.hasOwn(row, 'font') ? '覆蓋字體' : '保留字體'}</Tag> },
      ]} />
    <p className="pl-muted" style={{ margin: '8px 0 0', fontSize: 12 }}>既有分組順序不變，新分組追加在末尾。匯入後先加入整理草稿，按「保存」才生效。來源未提供字體時保留現有設定；清除預設不會清除文字的個別字體。</p>
  </Modal>
}
