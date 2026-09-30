import { base } from './api'
import type { Availability } from './types'

/** The web bundle is independent of OCR assets; explicit server overrides remain supported. */
export function displayFontUrl(bundledUrl: string, availability: Pick<Availability, 'display_font_custom' | 'font_version'>): string {
  return availability.display_font_custom
    ? `${base}/font?v=${encodeURIComponent(availability.font_version || '')}`
    : bundledUrl
}
