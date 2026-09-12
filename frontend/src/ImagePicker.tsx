import { useRef, useState, type DragEvent } from 'react'
import { Dropdown } from 'antd'
import { acceptsImage, readDroppedDirectory } from './directory-files'
import { selectedFiles } from './workbench-api'

export function ImagePicker({ label, mask = false, disabled = false, onSelect, onBusyChange }: {
  label: string
  mask?: boolean
  disabled?: boolean
  onSelect: (files: File[], folderName?: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const images = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const locked = disabled || loading
  function accept(files: File[], folderName?: string) {
    onSelect(files, folderName)
    setError(files.length ? '' : `沒有可匯入的${mask ? ' PNG Mask' : '圖片'}，資料夾僅匯入第一層。`)
  }
  function choose(files: FileList | null, directory = false) {
    if (!files?.length) return // Cancellation preserves the previous selection.
    accept(selectedFiles(files, mask), directory ? files[0].webkitRelativePath.replace(/\\/g, '/').split('/')[0] : undefined)
  }
  async function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (locked) return
    // Capture entries before awaiting, while the drop data store is readable.
    const entries = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.())
    if (!entries.length || entries.some(entry => !entry)) {
      setError('無法讀取拖入項目，請點擊選取圖片或資料夾。'); return
    }
    const roots = entries as FileSystemEntry[]
    if (roots.some(entry => entry.isDirectory) && roots.length !== 1) {
      setError('請拖入單個資料夾，或多張圖片。'); return
    }
    setLoading(true); onBusyChange(true); setError('')
    try {
      if (roots[0].isDirectory) accept(await readDroppedDirectory(roots[0] as FileSystemDirectoryEntry, mask), roots[0].name)
      else {
        const files = await Promise.all(roots.filter(entry => entry.isFile && acceptsImage(entry.name, mask)).map(entry =>
          new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))))
        accept(selectedFiles(files, mask))
      }
    } catch { setError('圖片讀取失敗，請重新選取。') }
    finally { setLoading(false); onBusyChange(false) }
  }
  return <div className="image-picker" role="group" aria-label={`選取${label}`}>
    <input ref={images} hidden type="file" multiple accept={mask ? '.png' : '.png,.jpg,.jpeg'} disabled={locked} onChange={e => { choose(e.target.files); e.target.value = '' }} />
    {/* Match the reference page's native chooser; filter nested paths before import. */}
    <input ref={folder} hidden type="file" multiple {...{ webkitdirectory: '' }} disabled={locked} onChange={e => { choose(e.target.files, true); e.target.value = '' }} />
    <div onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = locked ? 'none' : 'copy' }} onDrop={e => void drop(e)}>
      <Dropdown trigger={['click']} disabled={locked} menu={{ items: [{ key: 'images', label: '選擇多張圖片' }, { key: 'folder', label: '選擇單個資料夾' }], onClick: ({ key }) => { if (!locked) (key === 'folder' ? folder : images).current?.click() } }}>
        <button type="button" className="image-import-main" disabled={locked}>
          <strong>{loading ? '正在整理圖片…' : '拖入圖片或資料夾，或點擊選取'}</strong>
          <span>{mask ? 'PNG Mask' : 'PNG／JPG／JPEG'} · 資料夾僅匯入第一層</span>
        </button>
      </Dropdown>
    </div>
    {error && <small role="alert">{error}</small>}
  </div>
}
