export const base = '/api/prelayout'
export const projectPath = (id: string) => `${base}/projects/${id}`
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    const error = new Error(typeof value.detail === 'string' ? value.detail : `請求失敗 ${response.status}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response.json()
}
export const body = (data: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
export function files(list: FileList | null) {
  return Array.from(list || []).filter(file => !file.name.startsWith('._') && (!file.webkitRelativePath || file.webkitRelativePath.split('/').length === 2))
}
export const previewUrl = (pid: string, page: { id: string; sha256: string; clean: string | null }, edge: number, clean = false) =>
  `${projectPath(pid)}/pages/${page.id}/preview?edge=${edge}&clean=${clean}&v=${encodeURIComponent(clean ? page.clean || page.sha256 : page.sha256)}`
