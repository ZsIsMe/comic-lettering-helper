// Run against a local test instance with a built frontend. The fixture uses no models.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { chromium } = require(process.env.PRELAYOUT_PLAYWRIGHT || 'playwright')

async function run() {
  const base = process.env.PRELAYOUT_TEST_URL || 'http://127.0.0.1:6028'
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'prelayout-offline-test-'))
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PRELAYOUT_CHROME })
  const online = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  let api
  try {
    const image = await online.screenshot()
    const created = await online.request.post(base + '/api/prelayout/projects', { multipart: {
      name: '離線編輯測試', source_files: { name: '001.png', mimeType: 'image/png', buffer: image },
    } })
    assert.equal(created.status(), 201)
    const project = await created.json()
    api = base + '/api/prelayout/projects/' + project.id
    const item = { text: '匯出時的文字', x: .5, y: .5, 'font-size': 42, source: { note: '保留原文' } }
    const imported = await online.request.post(api + '/imports', { multipart: {
      kind: 'bt', expected_revision: '0', apply: 'true',
      files: { name: 'Meo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ transMap: { '001.png': [item] } })) },
    } })
    assert.equal(imported.status(), 200)
    await online.addInitScript(id => localStorage.setItem('pl-last-project', id), project.id)
    await online.goto(base + '/#/prelayout')
    await online.getByRole('button', { name: /匯入與準備/ }).click()
    const downloaded = online.waitForEvent('download')
    await online.getByRole('button', { name: '匯出離線編輯包' }).click()
    const archive = path.join(temp, 'project.zip'), folder = path.join(temp, 'unpacked')
    await (await downloaded).saveAs(archive)
    execFileSync('python3', ['-m', 'zipfile', '-e', archive, folder])

    const recipient = await browser.newContext({ offline: true, viewport: { width: 1440, height: 900 } })
    const page = await recipient.newPage(), errors = [], network = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()) })
    // Exercise file-input and download support even on a browser with native file pickers.
    await page.addInitScript(() => {
      for (const key of ['showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker'])
        Object.defineProperty(window, key, { configurable: true, value: undefined })
    })
    const open = async () => {
      await page.goto(pathToFileURL(path.join(folder, 'index.html')).href)
      await page.locator('input[webkitdirectory]').setInputFiles(folder)
      await page.locator('.pl-text[data-item]').first().waitFor()
    }
    await open()
    await page.locator('.pl-text[data-item]').first().dblclick()
    const editor = page.getByRole('textbox', { name: '原位編輯文字', exact: true })
    await editor.fill('離線編輯\n保存後繼續')
    await editor.press('Escape')
    await page.getByRole('button', { name: '右上：放大文字', exact: true }).click()
    const saved = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存 Meo.json', exact: true }).click()
    await (await saved).saveAs(path.join(folder, 'Meo.json'))
    const json = JSON.parse(await fs.readFile(path.join(folder, 'Meo.json'), 'utf8'))
    assert.equal(json.transMap['001.png'][0].text, '離線編輯\n保存後繼續')
    assert.equal(json.transMap['001.png'][0]['font-size'], 44)
    assert.deepEqual(json.transMap['001.png'][0].source, item.source)
    await page.reload()
    await open()
    await page.locator('.pl-text[data-item]').first().dblclick()
    assert.equal(await editor.innerText(), json.transMap['001.png'][0].text)
    assert.deepEqual(errors, [])
    assert.deepEqual(network, [])
    console.log('通過工作台匯出、file:// 離線修改、保存及重開')
  } finally {
    try { if (api) await online.request.delete(api) }
    finally { await browser.close(); await fs.rm(temp, { recursive: true, force: true }) }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
