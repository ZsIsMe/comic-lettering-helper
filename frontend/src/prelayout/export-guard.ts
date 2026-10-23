// All project downloads must observe the same synchronous save status, rather
// than relying on a disabled button or a render's captured boolean values.
export class ProjectExportGuard {
  private pending = new Set<string>()
  private revision = 0
  private exporting = false

  setPending(source: string, pending: boolean) {
    if (this.pending.has(source) === pending) return
    if (pending) this.pending.add(source)
    else this.pending.delete(source)
    this.invalidate()
  }

  invalidate() { this.revision += 1 }

  async run(flush: () => Promise<boolean>, download: (assertCurrent: () => void) => Promise<void>) {
    if (this.exporting) throw new Error('正在導出，請稍候。')
    const revision = this.revision
    const assertCurrent = () => {
      if (this.pending.size) throw new Error('疑問保存結果尚未確認，請先重試保存，再導出。')
      if (revision !== this.revision) throw new Error('導出期間內容或保存狀態已有變更，請重新導出。')
    }
    assertCurrent()
    this.exporting = true
    try {
      if (!await flush()) throw new Error('文字尚未保存，請先處理保存錯誤或版本衝突，再導出。')
      assertCurrent()
      await download(assertCurrent)
    } finally { this.exporting = false }
  }
}
