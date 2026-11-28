import { uid, type Item, type PageData } from './types'

export type OfflineManifestPage = {
  id: string; name: string; width: number; height: number; original: string;
  overlay?: string; clean?: string; itemIds: string[];
  line_break_suggestions?: PageData['line_break_suggestions'];
}
export type OfflineManifest = { version: 1; name: string; pages: OfflineManifestPage[] }
export type OfflineMeo = Record<string, unknown> & { transMap: Record<string, unknown[]> }
export type OfflineImageKind = 'original' | 'overlay' | 'clean'
type Files = Iterable<File> | ArrayLike<File>
const copy = <T,>(value: T): T => structuredClone(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string => typeof value === 'string' && /^t_[a-f0-9]{32}$/.test(value)
const identityKey = '_offlinePrelayout'

function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || Array.from(value).some(char => char.charCodeAt(0) < 32)) {
    throw new Error('檔案相對路徑無效。')
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`檔案相對路徑無效：${value}`)
  return value
}

async function json(file: File): Promise<unknown> {
  let value: unknown
  try { value = JSON.parse((await file.text()).replace(/^\uFEFF/, '')) }
  catch { throw new Error(`${file.name} 不是有效的 JSON。`) }
  const finite = (entry: unknown): void => {
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error(`${file.name} 包含非有限數字。`)
    if (Array.isArray(entry)) entry.forEach(finite)
    else if (object(entry)) Object.values(entry).forEach(finite)
  }
  finite(value)
  return value
}

function suggestionsData(value: unknown): NonNullable<PageData['line_break_suggestions']> {
  if (!object(value) || Object.keys(value).length > 5000) throw new Error('斷句候選資料格式無效。')
  for (const [id, suggestion] of Object.entries(value)) {
    if (!validId(id) || !object(suggestion) || typeof suggestion.original_text !== 'string' || suggestion.original_text.length > 50000 ||
      typeof suggestion.source_line_count !== 'number' || !Number.isInteger(suggestion.source_line_count) || suggestion.source_line_count < 0 ||
      !Array.isArray(suggestion.candidates) || suggestion.candidates.length > 100 || suggestion.candidates.some(candidate =>
        !object(candidate) || typeof candidate.text !== 'string' || candidate.text.length > 50000 ||
        typeof candidate.line_count !== 'number' || !Number.isInteger(candidate.line_count) || candidate.line_count < 1)) {
      throw new Error('斷句候選的文字、行數或文字 ID 無效。')
    }
  }
  return copy(value) as NonNullable<PageData['line_break_suggestions']>
}

function manifestData(value: unknown): OfflineManifest {
  if (!object(value) || value.version !== 1 || typeof value.name !== 'string' || !Array.isArray(value.pages) || !value.pages.length) {
    throw new Error('project.json 須包含 version: 1、name 及非空 pages。')
  }
  const ids = new Set<string>(), names = new Set<string>()
  const pages = value.pages.map((page: unknown): OfflineManifestPage => {
    if (!object(page) || typeof page.id !== 'string' || !page.id || typeof page.name !== 'string' || !page.name ||
      typeof page.width !== 'number' || !Number.isInteger(page.width) || page.width < 1 ||
      typeof page.height !== 'number' || !Number.isInteger(page.height) || page.height < 1 ||
      !Array.isArray(page.itemIds) || !page.itemIds.every(validId) || new Set(page.itemIds).size !== page.itemIds.length) {
      throw new Error('project.json 頁面尺寸、名稱或文字 ID 無效。')
    }
    if (ids.has(page.id) || names.has(page.name)) throw new Error(`project.json 頁面 ID 或名稱重複：${page.name}`)
    ids.add(page.id); names.add(page.name)
    return { id: page.id, name: page.name, width: page.width, height: page.height, original: path(page.original),
      ...(page.overlay === undefined ? {} : { overlay: path(page.overlay) }),
      ...(page.clean === undefined ? {} : { clean: path(page.clean) }), itemIds: [...page.itemIds],
      ...(page.line_break_suggestions === undefined ? {} : { line_break_suggestions: suggestionsData(page.line_break_suggestions) }) }
  })
  return { version: 1, name: value.name, pages }
}

function meoData(value: unknown): OfflineMeo {
  if (!object(value) || !object(value.transMap) || Object.values(value.transMap).some(items => !Array.isArray(items))) {
    throw new Error('Meo.json 須包含 transMap，且每頁文字須為陣列。')
  }
  return copy(value) as OfflineMeo
}

// Match the backend validate_items defaults/ranges without importing server or API code.
function itemsData(source: unknown[], width: number, height: number, identity: (item: Record<string, unknown>, index: number) => string): Item[] {
  if (source.length > 5000) throw new Error('每頁文字不可超過 5,000 條。')
  const ids = new Set<string>(), indices = new Set<number>()
  let nextIndex = Math.max(0, ...source.map(item => object(item) && Number.isInteger(item.index) ? item.index as number : 0)) + 1
  return source.map((entry, index) => {
    if (!object(entry)) throw new Error('文字條目必須是物件。')
    const item = copy(entry), id = identity(item, index)
    if (!validId(id) || ids.has(id)) throw new Error('文字 ID 重複或無效。')
    ids.add(id); item._id = id
    if (!Number.isInteger(item.index) || (item.index as number) < 1 || indices.has(item.index as number)) item.index = nextIndex++
    indices.add(item.index as number)
    if (item.text === undefined) item.text = ''
    if (typeof item.text !== 'string' || item.text.length > 50000) throw new Error('文字內容格式錯誤或過長。')
    const number = (key: string, fallback: number, low: number, high: number) => {
      if (item[key] === undefined) item[key] = fallback
      const value = item[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error(`文字 ${key} 超出可用範圍。`)
    }
    number('x', .5, -1, 2); number('y', .5, -1, 2); number('font-size', 40, 1, 999)
    number('rotation', 0, -180, 180); number('stroke-weight', 0, 0, 99)
    if (item.orientation === undefined) item.orientation = 'vertical'
    if (item.orientation !== 'horizontal' && item.orientation !== 'vertical') throw new Error('排版方向無效。')
    for (const [key, fallback] of [['color', '#000000'], ['stroke-color', '#FFFFFF']]) {
      if (item[key] === undefined) item[key] = fallback
      if (typeof item[key] !== 'string' || !/^(?:#?[a-fA-F0-9]{6}|black|white)$/.test(item[key] as string)) throw new Error('文字或描邊顏色無效。')
    }
    const box = item.xyxy_pixel, bound = Math.max(width, height)
    if (box !== undefined && box !== null && (!Array.isArray(box) || box.length !== 4 ||
      box.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < -bound * 2 || value > bound * 3) || box[2] < box[0] || box[3] < box[1])) {
      throw new Error('文字框格式或大小無效。')
    }
    return item as Item
  })
}

/** A selected directory is read only. Saving produces a new Meo.json download. */
export class OfflineProject {
  pages: PageData[] = []
  meo: OfflineMeo
  private urls = new Map<string, string>()
  private disposed = false

  constructor(readonly manifest: OfflineManifest, private readonly files: ReadonlyMap<string, File>, meo: OfflineMeo) {
    this.meo = meo
    this.installMeo(meo)
  }

  private installMeo(document: OfflineMeo, replacing = false) {
    const extension = document[identityKey]
    if (extension !== undefined && (!object(extension) || extension.version !== 1 || !object(extension.itemIds))) {
      throw new Error('Meo.json 的離線文字 ID 資料無效。')
    }
    const savedIds = object(extension) ? extension.itemIds as Record<string, unknown> : undefined
    const nextPages = this.manifest.pages.map(page => {
      if (!Object.hasOwn(document.transMap, page.name)) throw new Error(`Meo.json 缺少頁面：${page.name}`)
      const entries = document.transMap[page.name]
      const ids = savedIds?.[page.name]
      if (ids !== undefined && (!Array.isArray(ids) || ids.length !== entries.length || !ids.every(validId))) {
        throw new Error(`Meo.json 的文字 ID 與頁面不符：${page.name}`)
      }
      const previous = this.pages.find(value => value.id === page.id)
      const byIndex = new Map(previous?.items.map(item => [item.index, item._id]))
      const items = itemsData(entries, page.width, page.height, (item, index) => {
        if (Array.isArray(ids)) return ids[index] as string
        if (item._id !== undefined) return item._id as string
        // Explicit reloads use stable Meo indices, never shifted array positions.
        if (replacing) return byIndex.get(item.index as number) || uid()
        return page.itemIds[index] || uid()
      })
      return { id: page.id, name: page.name, width: page.width, height: page.height, revision: 0,
        sha256: '', clean: page.overlay || page.clean || null, items, measure: [],
        ...(page.line_break_suggestions === undefined ? {} : { line_break_suggestions: copy(page.line_break_suggestions) }) } satisfies PageData
    })
    // Commit only after every page validates, preserving edits on reload failure.
    this.meo = document; this.pages = nextPages
  }

  async replaceMeo(file: File): Promise<void> {
    this.assertOpen()
    const document = meoData(await json(file))
    this.assertOpen(); this.installMeo(document, true)
  }

  setPageItems(pageId: string, items: Item[]): void {
    this.assertOpen()
    const page = this.pages.find(value => value.id === pageId)
    if (!page) throw new Error('頁面不存在。')
    page.items = itemsData(items, page.width, page.height, item => item._id as string)
    page.revision += 1
  }

  imageUrl(pageId: string, kind: OfflineImageKind = 'original'): string | undefined {
    this.assertOpen()
    const page = this.manifest.pages.find(value => value.id === pageId)
    if (!page) throw new Error('頁面不存在。')
    const relative = page[kind]
    if (!relative) return undefined
    const cached = this.urls.get(relative)
    if (cached) return cached
    const file = this.files.get(relative)
    if (!file) throw new Error(`缺少圖片：${relative}`)
    const url = URL.createObjectURL(file)
    this.urls.set(relative, url)
    return url
  }

  exportMeo(): OfflineMeo {
    this.assertOpen()
    const document = copy(this.meo)
    const itemIds: Record<string, string[]> = Object.create(null)
    for (const page of this.pages) {
      const items = itemsData(page.items, page.width, page.height, item => item._id as string)
      itemIds[page.name] = items.map(item => item._id)
      // Same export_item contract as the server: internal IDs stay out of BT items.
      document.transMap[page.name] = items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== '_id')))
    }
    const previous = document[identityKey]
    document[identityKey] = { ...(object(previous) ? previous : {}), version: 1, itemIds }
    return document
  }

  meoBlob(): Blob { return new Blob([JSON.stringify(this.exportMeo(), null, 2)], { type: 'application/json;charset=utf-8' }) }

  dispose(): void {
    this.urls.forEach(url => URL.revokeObjectURL(url))
    this.urls.clear(); this.disposed = true
  }

  private assertOpen() { if (this.disposed) throw new Error('離線項目已關閉，請重新選擇資料夾。') }
}

export async function loadOfflineProject(files: Files, replacementMeo?: File): Promise<OfflineProject> {
  const selected = Array.from(files as ArrayLike<File>), indexed = new Map<string, File>()
  for (const file of selected) {
    const relative = path(file.webkitRelativePath || file.name)
    if (relative.split('/').some(part => part.startsWith('._') || part === '__MACOSX')) continue
    if (indexed.has(relative)) throw new Error(`檔案路徑重複：${relative}`)
    indexed.set(relative, file)
  }
  const manifests = [...indexed.keys()].filter(relative => relative.split('/').at(-1) === 'project.json')
  if (manifests.length !== 1) throw new Error('請選擇包含唯一 project.json 的離線項目資料夾。')
  const manifestPath = manifests[0], base = manifestPath.slice(0, -'project.json'.length)
  const manifest = manifestData(await json(indexed.get(manifestPath)!))
  const projectFiles = new Map([...indexed].filter(([relative]) => relative.startsWith(base)).map(([relative, file]) => [relative.slice(base.length), file]))
  const meo = projectFiles.get('Meo.json')
  if (!meo) throw new Error('離線項目缺少 Meo.json。')
  const missing = [...new Set(manifest.pages.flatMap(page => [page.original, page.overlay, page.clean].filter((value): value is string => !!value)))].filter(relative => !projectFiles.has(relative))
  if (missing.length) throw new Error(`離線項目缺少圖片：${missing.join('、')}`)
  const project = new OfflineProject(manifest, projectFiles, meoData(await json(meo)))
  if (replacementMeo) {
    try { await project.replaceMeo(replacementMeo) }
    catch (error) { project.dispose(); throw error }
  }
  return project
}
