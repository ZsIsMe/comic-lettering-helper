import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/workflow-progress.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { firstTimingText, formatWorkflowSeconds, friendlyWorkflowText, remainingTimingText, warmTimingText, workflowName, workflowStateLabel } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('internal workflow ids always render as friendly product names', () => {
  assert.equal(workflowName('qwen2511_lanpaint'), 'Qwen Image 2.1 INT8')
  assert.equal(friendlyWorkflowText('running qwen2511_lanpaint after firered and flux2klein_lanpaint'), 'running Qwen Image 2.1 INT8 after FireRed FP8 and Flux2 Klein + LanPaint')
})

test('workflow states and durations are formatted without invented fallback timings', () => {
  assert.equal(workflowStateLabel('waiting'), '等待執行')
  assert.equal(workflowStateLabel('preparing'), '準備中')
  assert.equal(workflowStateLabel('running'), '運行中')
  assert.equal(workflowStateLabel('completed'), '已完成')
  assert.equal(formatWorkflowSeconds(null), '未記錄')
  assert.equal(formatWorkflowSeconds(0), '0 秒')
  assert.equal(formatWorkflowSeconds(65.4), '1 分 5 秒')
  assert.equal(formatWorkflowSeconds(3661), '1 小時 1 分 1 秒')
})

const progress = (state, changes = {}) => ({ state, completed: 0, total: 4, generated: 0, passthrough: 0, first_seconds: null, warm_average_seconds: null, elapsed_seconds: 0, remaining_seconds: null, started_at: null, finished_at: null, ...changes })

test('pending timings distinguish unfinished work from missing historical measurements', () => {
  for (const state of ['waiting', 'preparing', 'running']) {
    assert.equal(firstTimingText(progress(state)), '待完成')
    assert.equal(warmTimingText(progress(state)), '待完成')
  }
  assert.equal(remainingTimingText(progress('waiting')), '待估算')
  assert.equal(remainingTimingText(progress('preparing')), '待估算')
  assert.equal(remainingTimingText(progress('running')), '估算中')
})

test('terminal timings handle passthrough and old resumed jobs without inventing measurements', () => {
  assert.equal(firstTimingText(progress('completed', { completed: 4, passthrough: 4 })), '不需生成')
  assert.equal(warmTimingText(progress('completed', { completed: 4, passthrough: 4 })), '—')
  assert.equal(firstTimingText(progress('completed', { completed: 4, passthrough: 1 })), '未記錄')
  assert.equal(warmTimingText(progress('completed', { completed: 4, passthrough: 1 })), '未記錄')
  assert.equal(firstTimingText(progress('failed')), '未記錄')
  assert.equal(remainingTimingText(progress('failed')), '—')
  assert.equal(remainingTimingText(progress('abandoned')), '—')
  assert.equal(remainingTimingText(progress('completed', { remaining_seconds: 0 })), '—')
  assert.equal(warmTimingText(progress('completed', { completed: 2, first_seconds: 20, warm_average_seconds: 8.4 })), '8 秒／張')
})
