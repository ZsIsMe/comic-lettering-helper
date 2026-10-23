import type { TextReference } from './question-references'
import type { Item, Page } from './types'

/** Historical references locate stable identities; ordinals can move after deletion. */
export function questionReferencePage(pages: readonly Page[], reference: TextReference): Page {
  const byId = pages.find(page => page.id === reference.pageId)
  if (byId) return byId
  const exact = pages.filter(page => page.name === reference.pageName)
  if (exact.length === 1) return exact[0]
  const stem = (name: string) => name.replace(/\.[^.]*$/, '').toLocaleLowerCase()
  const matches = pages.filter(page => stem(page.name) === stem(reference.pageName))
  if (!exact.length && matches.length === 1) return matches[0]
  throw new Error('無法找到這筆疑問引用的頁面，可能已被移除或重新匯入。')
}

export function questionReferenceItem(items: readonly Item[], reference: TextReference): Item {
  const matches = items.filter(item => item._id === reference.itemId)
  if (matches.length !== 1) throw new Error('這筆疑問引用的文字框已不存在，無法定位；記錄內容仍保留。')
  return matches[0]
}
