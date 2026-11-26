import { Button, Input, Space } from 'antd'
import { layerUrl } from './api'
import type { Project } from './types'

type Props = {
  projects: Project[]
  recentProjectIds: string[]
  query: string
  onQueryChange: (query: string) => void
  onOpen: (project: Project) => void
  onRename: (project: Project) => void
  onDelete: (project: Project) => void
}

const nameOrder = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' })

export function ProjectLibrary({ projects, recentProjectIds, query, onQueryChange, onOpen, onRename, onDelete }: Props) {
  const keyword = query.trim().toLocaleLowerCase()
  const visibleProjects = projects.filter(project => project.name.toLocaleLowerCase().includes(keyword))
    .sort((a, b) => nameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id))
  const byId = new Map(projects.map(project => [project.id, project]))
  const recentProjects = [...new Set(recentProjectIds)].flatMap(id => {
    const project = byId.get(id)
    return project ? [project] : []
  }).slice(0, 3)

  function projectRow(project: Project) {
    const completed = project.pages.filter(page => typeof page.reviewed_revision === 'number' && page.reviewed_revision === page.revision).length
    const updated = new Date(project.updated_at)
    const updatedLabel = updated.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    return <article key={project.id} className="pl-project-row">
      <div className="pl-project-summary">
        <h3><button className="pl-project-name" title={project.name} onClick={() => onOpen(project)}>{project.name}</button></h3>
        <p className="pl-project-meta"><span className="pl-project-pages">{project.pages.length} 頁</span><span className="pl-project-progress">已完成 {completed} / {project.pages.length} 頁</span><span className="pl-project-updated" title={`最近更新：${updated.toLocaleString()}`}><time dateTime={project.updated_at}>{updatedLabel}</time></span></p>
      </div>
      <Space size={4} className="pl-project-actions">
        <Button size="small" type="primary" onClick={() => onOpen(project)}>開啟</Button>
        <Button size="small" onClick={() => onRename(project)}>改名</Button>
        <Button size="small" danger onClick={() => onDelete(project)}>刪除</Button>
      </Space>
    </article>
  }

  return <section aria-label="預排版項目">
    <section className="pl-recent-projects" aria-label="最近開啟">
      <h2 className="pl-library-heading">最近開啟</h2>
      {recentProjects.length ? <div className="pl-recent-strip">{recentProjects.map(project =>
        <button key={project.id} type="button" className="pl-recent-item" onClick={() => onOpen(project)} title={project.name}>
          <span className="pl-recent-cover">
            {project.pages[0] && <img src={layerUrl(project.id, project.pages[0], 'original', { edge: 384 })} alt="" decoding="async" />}
          </span>
          <span className="pl-recent-title">{project.name}</span>
        </button>
      )}</div>
        : <p className="pl-muted pl-recent-empty">尚無最近開啟的項目</p>}
    </section>
    <section aria-label="全部項目">
      <div className="pl-library-toolbar">
        <h2 className="pl-library-heading">全部項目</h2>
        <div className="pl-library-filters">
          <Input className="pl-library-search" size="small" aria-label="搜尋項目名稱" placeholder="搜尋項目名稱" allowClear value={query} onChange={event => onQueryChange(event.target.value)} />
          <span className="pl-muted" role="status">{keyword ? `${visibleProjects.length} / ${projects.length}` : projects.length} 個項目</span>
        </div>
      </div>
      <div className="pl-project-list">{visibleProjects.map(project => projectRow(project))}</div>
      {!visibleProjects.length && <div className="pl-library-empty"><span>沒有符合的項目</span><Button size="small" onClick={() => onQueryChange('')}>清除篩選</Button></div>}
    </section>
  </section>
}
