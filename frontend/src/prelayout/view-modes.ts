export type ViewMode = 'overlay' | 'original' | 'final'
export type ViewState = {
  clean: boolean; difference: boolean; showText: boolean;
  differenceColor: string; differenceOpacity: number;
}
export type ViewChange = {
  mode?: ViewMode; clean?: boolean; difference_highlight?: boolean; show_text?: boolean;
  difference_color?: string; difference_opacity?: number;
}

const modes: Record<ViewMode, Pick<ViewState, 'clean' | 'difference' | 'showText'>> = {
  overlay: { clean: true, difference: true, showText: true },
  original: { clean: false, difference: false, showText: false },
  final: { clean: true, difference: false, showText: true },
}

export function currentViewMode(state: ViewState, cleanAvailable: boolean): ViewMode | 'custom' {
  if (!cleanAvailable && state.clean) return 'custom'
  return (Object.keys(modes) as ViewMode[]).find(mode =>
    state.clean === modes[mode].clean && state.difference === modes[mode].difference && state.showText === modes[mode].showText,
  ) || 'custom'
}

export function resolveViewChange(current: ViewState, change: ViewChange, cleanAvailable: boolean): ViewState {
  const result = { ...current }
  if (change.mode !== undefined) {
    if (!Object.hasOwn(modes, change.mode)) throw new Error('檢視模式無效。')
    if (change.mode !== 'original' && !cleanAvailable) throw new Error('本頁沒有去字底圖，無法使用疊合或成品模式。')
    const preset = modes[change.mode]
    for (const [key, value] of Object.entries({ clean: change.clean, difference: change.difference_highlight, showText: change.show_text })) {
      if (value !== undefined && value !== preset[key as keyof typeof preset]) throw new Error('檢視模式與圖層開關互相矛盾。')
    }
    Object.assign(result, preset)
  }
  for (const value of [change.clean, change.difference_highlight, change.show_text]) {
    if (value !== undefined && typeof value !== 'boolean') throw new Error('顯示開關必須是布林值。')
  }
  if (change.clean !== undefined) result.clean = change.clean
  if (change.difference_highlight !== undefined) result.difference = change.difference_highlight
  if (change.show_text !== undefined) result.showText = change.show_text
  if (change.difference_color !== undefined) {
    if (typeof change.difference_color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(change.difference_color)) throw new Error('差異高亮顏色必須是 #RRGGBB。')
    result.differenceColor = change.difference_color.toLowerCase()
  }
  if (change.difference_opacity !== undefined) {
    if (typeof change.difference_opacity !== 'number' || !Number.isFinite(change.difference_opacity) || change.difference_opacity < 0 || change.difference_opacity > 1) throw new Error('差異高亮透明度必須介於 0 與 1。')
    result.differenceOpacity = change.difference_opacity
  }
  return result
}
