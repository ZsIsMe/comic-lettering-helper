/* Run against an isolated acceptance server; see docs/PRELAYOUT_LOCAL_VALIDATION.md. */
const { chromium } = require(process.env.PRELAYOUT_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const base = process.env.PRELAYOUT_TEST_URL || 'http://127.0.0.1:6018'
const output = path.resolve(process.env.PRELAYOUT_TEST_OUTPUT || 'var-test/prelayout-browser')
const fixture = JSON.parse(fs.readFileSync(path.join(output, 'fixture.json')))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const quantile = (values, p) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * p)]
async function until(fn, label, timeout = 12000) {
  const start = Date.now()
  while (!await fn()) { if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`); await sleep(100) }
}
;(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PRELAYOUT_CHROME ? { executablePath: process.env.PRELAYOUT_CHROME } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true })
  context.setDefaultTimeout(15000)
  const page = await context.newPage(), errors = [], failures = [], report = { browser: browser.version(), viewport: '1440×1000', dpr: 1, synthetic: true }
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`) })
  await page.addInitScript(id => { if (!localStorage.getItem('pl-last-project')) localStorage.setItem('pl-last-project', id) }, fixture.id)
  const api = `/api/prelayout/projects/${fixture.id}`
  const readPage = async (n = 0) => { const response = await page.request.get(`${base}${api}/pages/${fixture.pages[n].id}`); assert.equal(response.status(), 200); return response.json() }
  const save = async () => { await page.getByRole('button', { name: /保\s*存/, exact: true }).click(); await until(async () => await page.locator('.pl-title .ant-tag').innerText() === '已保存', 'saved') }
  const go = async n => { await page.locator('.pl-pages-nav button').nth(n).click(); await page.locator(`[data-page="${fixture.pages[n].id}"][data-readonly="false"] .pl-text`).first().waitFor() }
  const itemNode = id => page.locator(`[data-item="${id}"]`)
  const center = async locator => { const b = await locator.boundingBox(); assert(b); return [b.x + b.width / 2, b.y + b.height / 2] }
  try {
    const fresh = await (await page.request.get(`${base}${api}`)).json()
    const reset = await page.request.post(`${base}${api}/imports`, { multipart: { kind: 'bt', expected_revision: String(fresh.revision), apply: 'true', files: { name: 'sample_bt.json', mimeType: 'application/json', buffer: fs.readFileSync(path.join(output, 'sample_bt.json')) } } })
    assert.equal(reset.status(), 200)
    await page.route('**/api/prelayout/projects/*/pages/*/preview?*', async route => { await sleep(500); await route.continue() })
    await page.goto(`${base}/?prelayoutDiagnostics=1#/prelayout`)
    await page.locator('.pl-text').first().waitFor()
    await page.waitForFunction(() => [...document.fonts].some(font => font.family.replaceAll('"', '') === 'Prelayout CJK' && font.status === 'loaded'))
    await sleep(1200)
    const original = await readPage(), id = original.items[0]._id
    const start = await center(itemNode(id)), pageBounds = await page.locator(`[data-page="${fixture.pages[0].id}"]`).boundingBox(), scale = pageBounds.width / original.width
    let saves = 0, previews = 0, during = false
    page.on('request', request => { if (!during) return; if (request.method() === 'PATCH') saves++; if (request.url().includes('/preview?')) previews++ })
    await page.route('**/api/prelayout/projects/*/pages/*/text', async route => { await sleep(500); await route.continue() })
    await page.mouse.move(...start); await page.mouse.down(); during = true
    await page.evaluate(() => {
      window.__frames = []; window.__latency = []; window.__measuring = true; let previous = performance.now()
      function frame(time) { if (!window.__measuring) return; window.__frames.push(time - previous); previous = time; requestAnimationFrame(frame) }
      window.__measureMove = () => { const at = performance.now(); requestAnimationFrame(() => window.__latency.push(performance.now() - at)) }
      window.addEventListener('pointermove', window.__measureMove, { passive: true }); requestAnimationFrame(frame)
    })
    const end = Date.now() + 10000
    while (Date.now() < end) { const t = (10000 - (end - Date.now())) / 1000; await page.mouse.move(start[0] + 55 * Math.sin(t), start[1] + 35 * Math.cos(t)); await sleep(12) }
    await page.mouse.move(start[0] + 60, start[1] + 30)
    const timing = await page.evaluate(() => { window.__measuring = false; window.removeEventListener('pointermove', window.__measureMove); return { frames: window.__frames.slice(2), latency: window.__latency.slice(2) } })
    during = false; await page.mouse.up(); await save()
    assert.equal(saves, 0, 'No network saves during a drag'); assert.equal(previews, 0, 'No image requests during a drag')
    report.drag = { frameP95: quantile(timing.frames, .95), pointerRafP95: quantile(timing.latency, .95), seconds: 10, apiDelayMs: 500, previewDelayMs: 500 }
    assert(report.drag.frameP95 <= 20, 'Warm drag P95 frame interval <= 20 ms'); assert(report.drag.pointerRafP95 <= 50, 'Pointer-to-rAF P95 <= 50 ms')
    let data = await readPage(), changed = data.items.find(item => item._id === id)
    assert(Math.abs((changed.x - original.items[0].x) * original.width - 60 / scale) < 1)
    assert(Math.abs((changed.y - original.items[0].y) * original.height - 30 / scale) < 1)
    const shown = await center(itemNode(id)); assert(Math.abs(shown[0] - start[0] - 60) < 1, 'No double translation after commit')
    await page.getByRole('button', { name: /撤\s*銷/, exact: true }).click(); await save()
    assert.equal((await readPage()).items.find(item => item._id === id).x, original.items[0].x)
    await page.getByRole('button', { name: /重\s*做/, exact: true }).click(); await save()
    console.log('PASS drag, undo/redo, delayed save', report.drag)

    // Rotate a real handle around the data center, then verify the upstream negative CSS angle.
    const c = await center(itemNode(id)), handle = await center(page.getByRole('button', { name: '旋轉文字' }))
    const angle = Math.atan2(handle[1] - c[1], handle[0] - c[0]), radius = Math.hypot(handle[0] - c[0], handle[1] - c[1])
    await page.mouse.move(...handle); await page.mouse.down()
    for (let n = 1; n <= 30; n++) await page.mouse.move(c[0] + radius * Math.cos(angle + Math.PI / 4 * n / 30), c[1] + radius * Math.sin(angle + Math.PI / 4 * n / 30))
    await page.mouse.up(); await save(); changed = (await readPage()).items.find(item => item._id === id)
    assert(Math.abs(changed.rotation + 45) < 1)
    assert.match(await itemNode(id).getAttribute('style'), /rotate\(4[45]/)
    console.log('PASS rotation sign and persistence')

    const beforeKeys = changed.x
    await page.locator('.pl-viewport').focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await save(); assert(Math.abs((await readPage()).items.find(item => item._id === id).x - beforeKeys - 5 / original.width) < 1e-9)
    await page.getByRole('button', { name: /撤\s*銷/, exact: true }).click(); await save()
    assert.equal((await readPage()).items.find(item => item._id === id).x, beforeKeys, 'Key repeats form one undo step')
    await page.keyboard.press('F1')
    const view = await page.locator(`[data-page="${fixture.pages[0].id}"]`).boundingBox(), pasteAt = [view.x + view.width * .72, view.y + view.height * .2]
    await page.mouse.move(...pasteAt); await page.keyboard.press('F2'); await save()
    data = await readPage(); const pasted = data.items.at(-1)
    assert.equal(data.items.length, original.items.length + 1); assert(Math.abs(pasted.x - .72) < .003); assert(Math.abs(pasted.y - .2) < .003)
    assert.equal(pasted.rotation, changed.rotation)
    await page.getByRole('button', { name: /刪\s*除/, exact: true }).click(); await save()
    console.log('PASS grouped keyboard edits and pointer paste')

    // Ctrl-wheel zoom keeps the original pixel under the pointer fixed and prevents page zoom.
    await go(0); const point = [view.x + 330, view.y + 220]
    const anchorBefore = await page.evaluate(({ id, point }) => { const b = document.querySelector(`[data-page="${id}"]`).getBoundingClientRect(); return [(point[0]-b.left)/b.width, (point[1]-b.top)/b.height] }, { id: fixture.pages[0].id, point })
    await page.mouse.move(...point); await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control'); await sleep(400)
    const anchorAfter = await page.evaluate(({ id, point }) => { const b = document.querySelector(`[data-page="${id}"]`).getBoundingClientRect(); return [(point[0]-b.left)/b.width, (point[1]-b.top)/b.height, window.visualViewport.scale] }, { id: fixture.pages[0].id, point })
    assert(Math.abs(anchorBefore[0]-anchorAfter[0])*original.width < 2); assert(Math.abs(anchorBefore[1]-anchorAfter[1])*original.height < 2); assert.equal(anchorAfter[2], 1)
    await go(99); await sleep(800)
    assert(await page.locator('.pl-page-row').count() <= 4)
    const restoredTop = await page.locator('.pl-viewport').evaluate(el => el.scrollTop)
    await page.reload(); await page.locator(`[data-page="${fixture.pages[99].id}"]`).waitFor(); await sleep(400)
    assert(Math.abs(await page.locator('.pl-viewport').evaluate(el => el.scrollTop) - restoredTop) < 2, 'Restore zoom + page anchor')
    console.log('PASS zoom anchor, page 100 virtualization and refresh')

    await page.getByLabel('原圖對照', { exact: true }).check(); await go(97); await sleep(1600)
    assert.equal(await page.locator(`[data-page="${fixture.pages[97].id}"]`).count(), 2)
    await until(async () => await page.locator('[data-tile]').count() > 0, 'visible detail tiles', 30000)
    await page.screenshot({ path: path.join(output, 'large-page-compare.png') })
    await page.getByLabel('原圖對照', { exact: true }).uncheck(); await go(98); await sleep(1200)
    assert(await page.locator('[data-tile]').count() > 0)
    report.virtualization = { pages: 100, mounted: await page.locator('.pl-page-row').count(), longPage: '1200×24000', largePage: '8000×12000' }
    const system = await browser.newBrowserCDPSession(); report.processRssKiB = []
    for (let round = 0; round < 3; round++) {
      for (const index of [0, 24, 49, 74, 96, 99, 74, 49, 24, 0]) { await go(index); await sleep(180) }
      await sleep(1200)
      const processes = (await system.send('SystemInfo.getProcessInfo')).processInfo.map(process => process.id)
      const rss = execFileSync('ps', ['-o', 'rss=', '-p', processes.join(',')], {encoding:'utf8'}).trim().split(/\s+/).map(Number)
      report.processRssKiB.push(rss.reduce((a,b)=>a+b,0))
    }
    await sleep(1200)
    report.cache = await page.evaluate(() => window.__prelayoutCacheStats())
    assert(report.cache.decodedBytes <= report.cache.budget); assert(await page.locator('.pl-page-row').count() <= 4)
    console.log('PASS large/long image tiles and bounded cache', report.cache)

    // Atomic matching protects manual changes and leaves measure data untouched.
    const measureBefore = JSON.stringify((await readPage()).measure)
    await page.locator('.pl-text').first().click()
    await page.getByLabel('字級', { exact: true }).fill('72'); await page.getByLabel('字級', { exact: true }).press('Tab'); await save()
    const manualBefore = (await readPage()).items[0]
    await page.getByText('偵測與字級', { exact: true }).click()
    await page.getByRole('button', { name: '匹配譯文', exact: true }).click()
    await page.getByRole('button', { name: /套\s*用/, exact: true }).click()
    await until(async () => !await page.locator('.ant-modal-wrap:visible').count(), 'matching completed', 20000)
    assert.equal((await readPage()).items[0]['font-size'], manualBefore['font-size']); assert.equal(JSON.stringify((await readPage()).measure), measureBefore)
    await page.getByRole('button', { name: /撤\s*銷/, exact: true }).click(); await save()
    console.log('PASS manual matching protection and read-only measure')

    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '匯出 BT', exact: true }).click(); const download = await downloadEvent
    const btFile = path.join(output, 'export_bt.json'); await download.saveAs(btFile)
    const exported = JSON.parse(fs.readFileSync(btFile)); assert(!('_id' in exported.transMap['001.png'][0])); assert(exported.transMap['001.png'][0].fixture_unknown.retained)
    await page.screenshot({ path: path.join(output, 'editor.png') })
    await page.getByRole('button', { name: '項目列表', exact: true }).click()
    await page.getByRole('button', { name: '返回圖片修復', exact: true }).click()
    assert.equal(await page.locator('.pl-text').count(), 0); await page.keyboard.press('F2')
    const finalItems = (await readPage()).items.length; assert.equal(finalItems, original.items.length)
    console.log('PASS BT export and module isolation')
    report.errors = errors; report.serverFailures = failures
    assert.deepEqual(errors, []); assert.deepEqual(failures, [])
    report.passed = true
    fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
  } catch (error) {
    report.passed = false; report.failure = String(error); report.errors = errors; report.serverFailures = failures
    fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
