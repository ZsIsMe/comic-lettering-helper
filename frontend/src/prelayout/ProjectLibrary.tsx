import { Button, Input, Space } from 'antd'
import { previewUrl } from './api'
import type { Project } from './types'
import type { ProjectView } from './project-view'

type Props = {
  projects: Project[]
  view: ProjectView
  query: string
  onQueryChange: (query: string) => void
  onViewChange: (view: ProjectView) => void
  onOpen: (project: Project) => void
  onRename: (project: Project) => void
  onDelete: (project: Project) => void
}

export function ProjectLibrary({ projects, view, query, onQueryChange, onViewChange, onOpen, onRename, onDelete }: Props) {
  const keyword = query.trim().toLocaleLowerCase()
  const visibleProjects = projects.filter(project => project.name.toLocaleLowerCase().includes(keyword))
  return <section aria-label="預排版項目">
    <div className="pl-library-toolbar">
      <div className="pl-library-filters">
        <Input className="pl-library-search" size="small" aria-label="搜尋項目名稱" placeholder="搜尋項目名稱" allowClear value={query} onChange={event => onQueryChange(event.target.value)} />
        <span className="pl-muted" role="status">{keyword ? `${visibleProjects.length} / ${projects.length}` : projects.length} 個項目</span>
      </div>
      <Space role="group" aria-label="項目顯示模式">
        <Button aria-pressed={view === 'list'} type={view === 'list' ? 'primary' : 'default'} onClick={() => onViewChange('list')}>列表</Button>
        <Button aria-pressed={view === 'cards'} type={view === 'cards' ? 'primary' : 'default'} onClick={() => onViewChange('cards')}>卡片</Button>
      </Space>
    </div>
    <div className={view === 'list' ? 'pl-project-list' : 'pl-project-grid'}>
      {visibleProjects.map(project => {
        const completed = project.pages.filter(page => typeof page.reviewed_revision === 'number' && page.reviewed_revision === page.revision).length
        const updated = new Date(project.updated_at)
        const updatedLabel = view === 'list' ? updated.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : updated.toLocaleString()
        return <article key={project.id} className={view === 'list' ? 'pl-project-row' : 'pl-project-card'}>
          {view === 'cards' && <button className="pl-cover" onClick={() => onOpen(project)}><img src={previewUrl(project.id, project.pages[0], 384)} loading="lazy" alt={project.name} /></button>}
          <div className="pl-project-summary">
            <h2><button className="pl-project-name" title={project.name} onClick={() => onOpen(project)}>{project.name}</button></h2>
            <p className="pl-project-meta"><span className="pl-project-pages">{project.pages.length} 頁</span><span className="pl-project-progress">已完成 {completed} / {project.pages.length} 頁</span><span className="pl-project-updated" title={`最近更新：${updated.toLocaleString()}`}>{view === 'cards' && '最近更新：'}<time dateTime={project.updated_at}>{updatedLabel}</time></span></p>
          </div>
          <Space wrap={view === 'cards'} size={view === 'list' ? 4 : 'small'} className="pl-project-actions">
            <Button size={view === 'list' ? 'small' : 'middle'} type="primary" onClick={() => onOpen(project)}>{view === 'list' ? '開啟' : '繼續預排版'}</Button>
            <Button size={view === 'list' ? 'small' : 'middle'} onClick={() => onRename(project)}>改名</Button>
            <Button size={view === 'list' ? 'small' : 'middle'} danger onClick={() => onDelete(project)}>刪除</Button>
          </Space>
        </article>
      })}
    </div>
    {!visibleProjects.length && <div className="pl-library-empty"><span>沒有符合的項目</span><Button size="small" onClick={() => onQueryChange('')}>清除篩選</Button></div>}
  </section>
}
