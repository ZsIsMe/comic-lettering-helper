/// <reference types="vite/client" />
// Only the local benchmark can retain the old transport/lifetime for controlled A/B.
// Vite removes this branch from production builds.
export function baselinePageLoad() {
  return import.meta.env.DEV && new URLSearchParams(location.search).get('pageLoadMode') === 'baseline'
}
