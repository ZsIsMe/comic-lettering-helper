// Match the upload API's filename normalization before counting paired pages.
export function createMaskPlan(sources: { name: string }[], masks: { name: string }[]) {
  const stem = (name: string) => name.replace(/\\/g, '/').split('/').pop()!
    .replace(/[^0-9A-Za-z._\-\u0080-\uffff]+/g, '_').replace(/^[ .]+|[ .]+$/g, '').replace(/\.[^.]+$/, '')
  const sourceStems = sources.map(file => stem(file.name))
  const maskStems = masks.map(file => stem(file.name))
  const sourceSet = new Set(sourceStems), maskSet = new Set(maskStems)
  const invalid = sourceSet.size !== sources.length || maskSet.size !== masks.length || maskStems.some(s => !sourceSet.has(s))
  const supplied = sourceStems.filter(s => maskSet.has(s)).length
  return { supplied, missing: sources.length - supplied, invalid }
}
