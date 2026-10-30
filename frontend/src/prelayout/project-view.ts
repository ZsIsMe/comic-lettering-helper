export type ProjectView = 'list' | 'cards'

const storageKey = 'pl-project-view'
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadProjectView(storage?: ViewStorage): ProjectView {
  try {
    return (storage ?? localStorage).getItem(storageKey) === 'cards' ? 'cards' : 'list'
  } catch {
    return 'list'
  }
}

export function saveProjectView(view: ProjectView, storage?: ViewStorage): void {
  try { (storage ?? localStorage).setItem(storageKey, view) } catch { /* Optional display preference. */ }
}
