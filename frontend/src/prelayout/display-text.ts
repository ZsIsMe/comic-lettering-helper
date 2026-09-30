import type { Item } from './types'

const quotes: Record<string, string> = { '「': '｢', '」': '｣', '“': '‶', '”': '〟' }

/** Desktop GUI symbol rules for display only. Never write this result back to items. */
export function displayText(text: string, orientation: Item['orientation']): string {
  return text
    .replace(/[「」“”]/g, char => quotes[char])
    .replace(/[!-/:-@\u005B-\u0060{-~]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xFEE0))
    .replace(/[0-9]/g, char => orientation === 'vertical' ? String.fromCharCode(char.charCodeAt(0) + 0xFEE0) : char)
}
