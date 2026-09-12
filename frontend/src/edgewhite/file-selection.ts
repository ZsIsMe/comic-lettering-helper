/** No recursive directory input: enumerate only the explicitly selected root. */
export function inputFiles(files: FileList | readonly File[] | null) {
  const all = Array.from(files || []).filter(f => !ignored(f.name) && (!f.webkitRelativePath || f.webkitRelativePath.split('/').length <= 2))
  const bad = all.find(f => !/\.(png|jpe?g)$/i.test(f.name))
  if (bad) throw new Error(`不支援 ${bad.name}，請選 PNG／JPG／JPEG 圖片`)
  const stems = new Set<string>()
  for (const file of all) {
    const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase()
    if (stems.has(stem)) throw new Error(`檔名重複：${stem}`)
    stems.add(stem)
  }
  if (all.length > 10000) throw new Error('一次最多匯入 10000 張圖片')
  return all
}
function ignored(name: string) { return name.startsWith('.') || name === 'edgewhite_guides.json' }
interface FileHandle { kind: 'file'; name: string; getFile: () => Promise<File> }
export interface DirectoryHandle { kind: 'directory'; name: string; values: () => AsyncIterable<FileHandle | DirectoryHandle> }
export interface DropEntry {
  name: string; isFile: boolean; isDirectory: boolean
  file?: (resolve: (file: File) => void, reject: (error: DOMException) => void) => void
  createReader?: () => { readEntries: (resolve: (entries: DropEntry[]) => void, reject: (error: DOMException) => void) => void }
}
export interface RootSelection { files: File[]; name: string; ignoredDirectories: number }

export async function readRootDirectory(root: DirectoryHandle): Promise<RootSelection> {
  const files: File[] = []
  let ignoredDirectories = 0
  for await (const entry of root.values()) {
    if (entry.kind === 'directory') { ignoredDirectories++; continue }
    if (!ignored(entry.name)) files.push(await entry.getFile())
    if (files.length > 10000) throw new Error('一次最多匯入 10000 張圖片')
  }
  return { files: inputFiles(files), name: root.name, ignoredDirectories }
}

export async function readDroppedRoots(entries: DropEntry[]): Promise<RootSelection> {
  if (!entries.length) throw new Error('此瀏覽器未提供資料夾結構，請改用多選圖片')
  const directories = entries.filter(e => e.isDirectory)
  if (directories.length && entries.length !== 1) throw new Error('一次請拖入一個資料夾，或直接拖入多張圖片')
  const files: File[] = []
  let ignoredDirectories = 0
  async function readFile(entry: DropEntry) {
    if (entry.isDirectory) { ignoredDirectories++; return }
    if (entry.isFile && entry.file && !ignored(entry.name)) {
      files.push(await new Promise<File>((resolve, reject) => entry.file!(resolve, reject)))
      if (files.length > 10000) throw new Error('一次最多匯入 10000 張圖片')
    }
  }
  if (directories.length) {
    const reader = directories[0].createReader?.()
    if (!reader) throw new Error('此瀏覽器無法讀取資料夾，請改用多選圖片')
    // readEntries may return the root in batches (e.g. 100 entries). Never open child readers.
    for (;;) {
      const batch = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      for (const entry of batch) await readFile(entry)
    }
  } else for (const entry of entries) await readFile(entry)
  return { files: inputFiles(files), name: directories[0]?.name || '', ignoredDirectories }
}
