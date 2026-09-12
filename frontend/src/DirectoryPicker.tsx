import { useState, type DragEvent, type ReactNode } from 'react'
import { Button, message } from 'antd'
import { readDirectoryFiles, readDroppedDirectory, type DirectoryPickerWindow } from './directory-files'

export function DirectoryPicker({ children, mask = false, disabled, onSelect, className }: {
  children: ReactNode
  mask?: boolean
  disabled?: boolean
  className?: string
  onSelect: (files: File[], folderName: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const supported = typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
  function selected(files: File[], folderName: string) {
    onSelect(files, folderName)
    setStatus(`「${folderName}」：已選 ${files.length} 張${mask ? ' PNG Mask' : '圖片'}`)
    if (!files.length) message.info('此文件夾第一層沒有符合格式的圖片')
  }
  function failed(error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      setStatus('文件夾選擇未完成。若已選中仍出現此訊息，請將文件夾拖入下方，或使用多選圖片。')
    } else {
      const detail = error instanceof Error ? error.message : String(error)
      setStatus(`無法讀取文件夾：${detail}`)
    }
  }
  async function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (disabled || loading) return
    // Capture entries before awaiting; DataTransfer is readable only in the event.
    const entries = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.())
    if (entries.length !== 1 || !entries[0]?.isDirectory) {
      setStatus('請一次拖入一個文件夾；個別圖片請使用多選圖片。')
      return
    }
    const directory = entries[0] as FileSystemDirectoryEntry
    setLoading(true); setStatus(`正在讀取「${directory.name}」第一層…`)
    try { selected(await readDroppedDirectory(directory, mask), directory.name) }
    catch (error) { failed(error) }
    finally { setLoading(false) }
  }
  async function select() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker
    if (!picker) return
    setLoading(true)
    setStatus('等待選擇文件夾…')
    try {
      const directory = await picker.call(window, { mode: 'read' })
      setStatus(`正在讀取「${directory.name}」第一層…`)
      const files = await readDirectoryFiles(directory, mask)
      selected(files, directory.name)
    } catch (error) {
      failed(error)
    } finally { setLoading(false) }
  }
  return <div className="directory-picker">
    <Button className={className} disabled={disabled || !supported} loading={loading} onClick={() => void select()}>{children}</Button>
    {!supported && <small>目前瀏覽器不支援文件夾按鈕，請拖入文件夾或使用多選圖片。</small>}
    <div className={`directory-drop ${disabled || loading ? 'disabled' : ''}`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled || loading ? 'none' : 'copy' }} onDrop={event => void drop(event)}>拖入文件夾（只讀第一層）</div>
    {status && <small role="status" style={{ display: 'block', maxWidth: 420, overflowWrap: 'anywhere' }}>{status}</small>}
  </div>
}
