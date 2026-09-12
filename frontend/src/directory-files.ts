export type DirectoryEntry =
  | { kind: 'file'; name: string; getFile(): Promise<File> }
  | { kind: 'directory'; name: string }

export interface ShallowDirectory {
  name: string
  values(): AsyncIterableIterator<DirectoryEntry>
}

export type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'read' }) => Promise<ShallowDirectory>
}

export function acceptsImage(name: string, mask = false): boolean {
  return !name.startsWith('._') && (mask ? /\.png$/i : /\.(png|jpe?g)$/i).test(name)
}

// Drag-and-drop grants access through a different browser API. readEntries can
// return the direct entries in several batches; do not recurse into any child.
export async function readDroppedDirectory(directory: FileSystemDirectoryEntry, mask = false): Promise<File[]> {
  const reader = directory.createReader()
  const files: File[] = []
  for (;;) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!entries.length) break
    for (const entry of entries) {
      if (!entry.isFile || !acceptsImage(entry.name, mask)) continue
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      files.push(file)
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

// Only inspect direct entries. Never open or enumerate a child directory.
export async function readDirectoryFiles(directory: ShallowDirectory, mask = false): Promise<File[]> {
  const files: File[] = []
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file' || !acceptsImage(entry.name, mask)) continue
    files.push(await entry.getFile())
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}
