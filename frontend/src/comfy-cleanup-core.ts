export type CleanupRoot = 'input' | 'output' | 'temp'
export type CleanupSignature = { device: number; inode: number; size: number; mtime_ns: number }
export type CleanupItem = {
  root: CleanupRoot; path: string; name: string; bytes: number; modified_at: string
  category: 'web_safe' | 'web_protected' | 'unknown'; job_id: string | null; job_name: string | null
  signature: CleanupSignature
}

export function cleanupPreviewUrl(item: Pick<CleanupItem, 'root' | 'path'>): string {
  const path = item.path.split('/').map(encodeURIComponent).join('/')
  return `/api/comfy-cleanup/preview/${encodeURIComponent(item.root)}/${path}`
}

export function cleanupQuery(after: string, before: string): string {
  const query = new URLSearchParams()
  if (after) query.set('unknown_after', after)
  if (before) query.set('unknown_before', before)
  const value = query.toString()
  return `/api/comfy-cleanup${value ? `?${value}` : ''}`
}

export function formatStorage(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}
