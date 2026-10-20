const QUESTION_PAGE_BATCH_SIZE = 6

export type QuestionPageLoaderOptions<T> = {
  pageIds: readonly string[]
  currentPageId?: string
  cached?: ReadonlyMap<string, T>
  load: (pageId: string) => Promise<T>
  onBatch: (loaded: Map<string, T>, errors: Map<string, string>, priorityDone: boolean) => void
  isActive: () => boolean
}

/** Open at the current page; an unavailable current page falls back to the first. */
export function questionPriorityPageIds(pageIds: readonly string[], currentPageId?: string): string[] {
  const ids = [...new Set(pageIds)]
  if (!ids.length) return []
  const found = currentPageId === undefined ? -1 : ids.indexOf(currentPageId)
  const index = found < 0 ? 0 : found
  return [ids[index], ids[index - 1], ids[index + 1]].filter((id): id is string => id !== undefined)
}

/**
 * Settle the current page and its neighbours before starting background reads.
 * Each notification is a settled batch, so consumers can render and anchor once.
 * Cancellation suppresses notifications and new requests; already running reads
 * may finish, without requiring the injected loader to support AbortSignal.
 */
export async function loadQuestionPages<T>({ pageIds, currentPageId, cached, load, onBatch, isActive }: QuestionPageLoaderOptions<T>): Promise<void> {
  const ids = [...new Set(pageIds)]
  const priorityIds = questionPriorityPageIds(ids, currentPageId)
  const prioritySet = new Set(priorityIds)
  const remainingIds = ids.filter(id => !prioritySet.has(id))

  async function batch(batchIds: readonly string[]): Promise<void> {
    const loaded = new Map<string, T>()
    const errors = new Map<string, string>()
    const results = await Promise.all(batchIds.map(async id => {
      if (!isActive()) return
      if (cached?.has(id)) return { id, value: cached.get(id) as T }
      try {
        return { id, value: await load(id) }
      } catch (error) {
        return { id, error: error instanceof Error ? error.message : String(error) }
      }
    }))
    if (!isActive()) return
    for (const result of results) {
      if (!result) continue
      if ('error' in result) errors.set(result.id, result.error as string)
      else loaded.set(result.id, result.value)
    }
    onBatch(loaded, errors, true)
  }

  if (!isActive()) return
  await batch(priorityIds)
  for (let index = 0; isActive() && index < remainingIds.length; index += QUESTION_PAGE_BATCH_SIZE) {
    await batch(remainingIds.slice(index, index + QUESTION_PAGE_BATCH_SIZE))
  }
}
