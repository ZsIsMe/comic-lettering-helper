export type LocalFont = { postscriptName: string; family: string; fullName: string; style: string; localizedFamily?: string; localizedFullName?: string; localizedStyle?: string }
export const fallbackFontFamily = '"Prelayout CJK","Noto Sans CJK JP","PingFang TC","Microsoft JhengHei",sans-serif'

export function fontName(value: unknown): string {
  return typeof value === 'string' && value.length <= 512 && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? value.trim() : ''
}

// One alias per exact face, so Bold/Regular do not collapse into the same CSS family.
export function localFontAlias(name: string): string {
  return `PLLocal-${Array.from(name).map(char => char.codePointAt(0)!.toString(16)).join('-')}`
}
export function itemFontFamily(value: unknown): string | undefined {
  const name = fontName(value)
  return name ? `"${localFontAlias(name)}",${fallbackFontFamily}` : undefined
}
const loaded = new Map<string, Promise<void>>()
const failed = new Set<string>()
export function loadLocalFont(value: unknown, retry = false): Promise<void> {
  const name = fontName(value)
  if (!name) return Promise.resolve()
  if (retry && failed.has(name)) { loaded.delete(name); failed.delete(name) }
  const existing = loaded.get(name)
  if (existing) return existing
  const pending = (async () => {
    const face = new FontFace(localFontAlias(name), `local(${JSON.stringify(name)})`)
    try { await face.load() } catch (error) { failed.add(name); throw error }
    document.fonts.add(face)
  })()
  loaded.set(name, pending)
  return pending
}

export async function browserFonts(): Promise<LocalFont[]> {
  const query = (window as Window & { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts
  if (!query) throw new Error('此瀏覽器不支援列出本機字體，請使用 Chrome 桌面版，或在本機 macOS 服務中開啟。')
  return query.call(window)
}
export function normalizeFonts(fonts: LocalFont[]): LocalFont[] {
  return [...new Map(fonts.filter(font => fontName(font.postscriptName)).map(font => [font.postscriptName, font])).values()]
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'zh-Hant'))
}

export type LocalFontFamily = { name: string; label: string; search: string; faces: LocalFont[] }
const chineseName = (value: string | undefined) => !!value && /[\u3400-\u9fff]/.test(value)
export function fontFamilyLabel(font: LocalFont): string {
  return font.localizedFamily || font.family || font.fullName || font.postscriptName
}
export function fontStyleLabel(font: LocalFont): string {
  return font.localizedStyle || font.style || font.fullName || font.postscriptName
}
const styleOrder = (font: LocalFont) => {
  const name = font.style.toLowerCase().replace(/[ -]/g, '')
  const weight = name.includes('ultralight') || name.includes('extralight') ? 200 : name.includes('thin') ? 100 : name.includes('light') ? 300
    : /regular|normal|book|roman/.test(name) ? 400 : name.includes('medium') ? 500 : /semibold|demibold/.test(name) ? 600
      : /extrabold|ultrabold/.test(name) ? 800 : /black|heavy/.test(name) ? 900 : name.includes('bold') ? 700 : 400
  return weight + (/italic|oblique/.test(name) ? 1000 : 0)
}
export function fontFamilies(fonts: LocalFont[]): LocalFontFamily[] {
  const groups = new Map<string, LocalFontFamily>()
  for (const font of fonts) {
    const name = font.family || font.postscriptName
    let group = groups.get(name)
    if (!group) { group = { name, label: fontFamilyLabel(font), search: '', faces: [] }; groups.set(name, group) }
    if (!chineseName(group.label) && chineseName(fontFamilyLabel(font))) group.label = fontFamilyLabel(font)
    group.faces.push(font)
    group.search += ` ${font.family} ${font.fullName} ${font.style} ${font.postscriptName} ${font.localizedFamily || ''} ${font.localizedFullName || ''} ${font.localizedStyle || ''}`
  }
  for (const group of groups.values()) group.faces.sort((a, b) => styleOrder(a) - styleOrder(b) || fontStyleLabel(a).localeCompare(fontStyleLabel(b), 'zh-Hant'))
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'))
}
export function selectedFontFamily(fonts: LocalFont[], values: unknown[]): string | undefined {
  const families = values.map(value => fonts.find(font => font.postscriptName === fontName(value))?.family)
  return families.length && families[0] && families.every(family => family === families[0]) ? families[0] : undefined
}
export function familyFace(family: LocalFontFamily, current?: LocalFont): LocalFont {
  return family.faces.find(font => current && font.style.toLowerCase() === current.style.toLowerCase())
    || family.faces.find(font => /^(regular|normal|book|roman)$/i.test(font.style)) || family.faces[0]
}
