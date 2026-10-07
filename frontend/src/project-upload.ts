export interface ProjectUploadProgress {
  stage: 'uploading' | 'waiting' | 'validating' | 'creating' | 'completed' | 'failed' | 'detecting'
  completed: number
  total: number
  filename?: string | null
  loaded?: number
  bytesTotal?: number
  error?: string | null
}

// Keep the existing multipart response contract while observing transfer and
// server-side preparation separately. An upload reaching 100% is not completion.
export function uploadProject<T>(body: FormData, onProgress: (progress: ProjectUploadProgress) => void): Promise<T> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollController: AbortController | undefined
    const stop = () => {
      stopped = true
      clearTimeout(timer)
      pollController?.abort()
    }
    const fail = (message: string) => { stop(); reject(new Error(message)) }
    const poll = async () => {
      pollController = new AbortController()
      // A lost status request must not stop later polling or the actual upload.
      const timeout = setTimeout(() => pollController?.abort(), 5000)
      try {
        const response = await fetch(`/api/projects/upload-progress/${id}`, { cache: 'no-store', signal: pollController.signal })
        if (response.ok) {
          const progress = await response.json() as ProjectUploadProgress
          if (!stopped) onProgress(progress)
        }
      } catch { /* The original POST remains authoritative for success/failure. */ }
      finally {
        clearTimeout(timeout)
        if (!stopped) timer = setTimeout(() => void poll(), 1000)
      }
    }
    xhr.open('POST', `/api/projects?progress_id=${id}`)
    // Register listeners before send so browsers emit upload progress events.
    xhr.upload.onprogress = event => {
      if (!stopped) onProgress({ stage: 'uploading', completed: 0, total: 0, loaded: event.loaded, bytesTotal: event.lengthComputable ? event.total : undefined })
    }
    xhr.upload.onload = () => {
      if (stopped) return
      onProgress({ stage: 'waiting', completed: 0, total: 0 })
      void poll()
    }
    xhr.onload = () => {
      stop()
      try {
        const payload = JSON.parse(xhr.responseText)
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail || '建立項目失敗')))
        } else resolve(payload as T)
      } catch { reject(new Error(`建立項目回應無法讀取（HTTP ${xhr.status}），請查看項目列表確認是否已建立。`)) }
    }
    xhr.onerror = () => fail('上傳連線中斷，請查看項目列表確認是否已建立。')
    xhr.onabort = () => fail('圖片上傳已中止')
    onProgress({ stage: 'uploading', completed: 0, total: 0, loaded: 0 })
    try { xhr.send(body) } catch (error) { stop(); reject(error) }
  })
}
