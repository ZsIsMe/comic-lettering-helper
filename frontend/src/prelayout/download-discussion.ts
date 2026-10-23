import { projectPath } from './api'
import { ProjectExportGuard } from './export-guard'

export function discussionFilename(name: string): string {
  const safe = Array.from(name).map(char => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char).join('').trim().slice(0, 120)
  return `${safe || '項目'}_疑問記錄.md`
}

async function downloadProject(projectId: string, endpoint: string, filename: string, flush: () => Promise<boolean>, guard: ProjectExportGuard, markdown: boolean): Promise<void> {
  await guard.run(flush, async assertCurrent => {
    const response = await fetch(`${projectPath(projectId)}/export/${endpoint}`, { cache: 'no-store' })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(typeof error.detail === 'string' ? error.detail : `導出失敗（${response.status}）`)
    }
    const media = response.headers.get('Content-Type') || ''
    if (markdown ? !/^text\/(markdown|plain)(;|$)/i.test(media) : !/^application\/json(;|$)/i.test(media)) throw new Error(`伺服器未返回 ${markdown ? 'Markdown' : 'JSON'} 文件，請確認應用版本已更新。`)
    const file = await response.blob()
    assertCurrent()
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url; link.download = filename
    document.body.appendChild(link)
    try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
  })
}

export function downloadDiscussion(project: { id: string; name: string }, flush: () => Promise<boolean>, guard = new ProjectExportGuard()): Promise<void> {
  return downloadProject(project.id, 'discussion', discussionFilename(project.name), flush, guard, true)
}

export function downloadMeo(project: { id: string }, flush: () => Promise<boolean>, guard: ProjectExportGuard): Promise<void> {
  return downloadProject(project.id, 'bt', 'Meo.json', flush, guard, false)
}
