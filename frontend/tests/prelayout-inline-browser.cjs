const { chromium } = require(process.env.PRELAYOUT_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = process.env.PRELAYOUT_TEST_URL || 'http://127.0.0.1:6028'
const output = path.resolve(process.env.PRELAYOUT_TEST_OUTPUT || 'var-test/inline-text')

;(async () => {
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, ...(process.env.PRELAYOUT_CHROME ? { executablePath: process.env.PRELAYOUT_CHROME } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  let api
  const button = name => page.getByRole('button', { name: new RegExp('^' + name.split('').join('\\s*') + '$') })
  const editor = () => page.getByRole('textbox', { name: '原位編輯文字', exact: true })
  try {
    const image = await page.screenshot()
    const response = await page.request.post(base + '/api/prelayout/projects', { multipart: {
      name: '原位文字編輯驗收（合成）', source_files: { name: '001.png', mimeType: 'image/png', buffer: image },
    } })
    assert.equal(response.status(), 201)
    const project = await response.json()
    api = base + '/api/prelayout/projects/' + project.id
    const items = ['horizontal', 'vertical', 'vertical'].map((orientation, index) => ({
      text: '甲乙丙\n丁戊己', x: .22 + index * .27, y: .35, 'font-size': 48,
      rotation: index === 2 ? 25 : 0, orientation, color: '#202020', 'stroke-color': '#ffffff', 'stroke-weight': 1,
      match_status: 'auto', custom: 'preserved',
    }))
    assert.equal((await page.request.post(api + '/imports', { multipart: { kind: 'bt', expected_revision: '0', apply: 'true',
      files: { name: 'text.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ transMap: { '001.png': items } })) },
    } })).status(), 200)
    const read = async () => (await page.request.get(api + '/pages/' + project.pages[0].id)).json()
    // Synthetic measurement response: label rendering requires no detector or GPU.
    await page.route(/\/api\/prelayout\/projects\/[^/]+\/pages\/[^/]+(?:\/text)?$/, async route => {
      const response = await route.fetch(), data = await response.json()
      data.measure = [{ xyxy_pixel: [210, 200, 400, 420], font_size: 46.5 }, { xyxy_pixel: [600, 200, 790, 420] }]
      await route.fulfill({ response, json: data })
    })
    await page.addInitScript(id => {
      localStorage.setItem('pl-last-project', id)
      localStorage.setItem('pl-view-' + id, JSON.stringify({ compare: false, showMeasure: false }))
    }, project.id)
    await page.goto(base + '/#/prelayout')
    await page.locator('.pl-text').first().waitFor()
    const before = await read(), ids = before.items.map(item => item._id)
    const node = index => page.locator(`[data-item="${ids[index]}"]`)
    assert.equal(await page.locator('.pl-current-font').count(), 3, 'Current size labels appear without selection')
    const save = async () => {
      await button('保存').click()
      await page.waitForFunction(() => document.querySelector('.pl-title .ant-tag').textContent === '已保存')
    }
    for (const index of [0, 1, 2]) {
      const bounds = await node(index).boundingBox()
      await node(index).dblclick()
      await editor().waitFor()
      assert.equal(await node(index).locator('.pl-current-font').innerText(), '48', 'Size label remains while typing')
      assert.equal(await editor().evaluate(el => getComputedStyle(el).writingMode), index ? 'vertical-rl' : 'horizontal-tb')
      const editingBounds = await node(index).boundingBox()
      for (const axis of ['x', 'y', 'width', 'height']) assert(Math.abs(bounds[axis] - editingBounds[axis]) < 1, `Entering edit shifted ${index} ${axis}`)
      assert.equal(await page.locator('.pl-text').count(), 3, 'Double click must not create a new item')
      if (index) {
        await editor().evaluate(el => getSelection().setPosition(el.firstChild, 1))
        const caret = () => editor().evaluate(() => ({ anchor: getSelection().anchorOffset, focus: getSelection().focusOffset }))
        await editor().press('ArrowLeft'); assert.deepEqual(await caret(), { anchor: 5, focus: 5 })
        await editor().press('ArrowRight'); assert.deepEqual(await caret(), { anchor: 1, focus: 1 })
        await editor().press('ArrowDown'); assert.deepEqual(await caret(), { anchor: 2, focus: 2 })
        await editor().press('ArrowUp'); assert.deepEqual(await caret(), { anchor: 1, focus: 1 })
        await editor().press('Shift+ArrowLeft'); assert.deepEqual(await caret(), { anchor: 1, focus: 5 })
        await editor().press('Shift+ArrowRight'); assert.deepEqual(await caret(), { anchor: 1, focus: 1 })
      }
      await editor().press('ControlOrMeta+A')
      await page.keyboard.insertText('第一行')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.insertText('第二行 ABC！')
      await page.keyboard.press(index ? 'ArrowUp' : 'ArrowLeft')
      await page.keyboard.press('Backspace')
      await page.keyboard.insertText('C')
      await page.screenshot({ path: path.join(output, `inline-${index}.png`) })
      await page.keyboard.press(index % 2 ? 'Meta+Enter' : 'Control+Enter')
      await save()
      const after = await read()
      assert.equal(after.items[index].text, '第一行\n\n第二行 ABC！')
      for (const key of ['x', 'y', 'rotation', 'orientation', 'font-size', 'color', 'stroke-color', 'stroke-weight', 'custom']) {
        assert.deepEqual(after.items[index][key], before.items[index][key], `Typing must preserve ${key}`)
      }
      await button('撤銷').click(); await save()
      assert.deepEqual((await read()).items[index], before.items[index], 'One undo restores the whole editing session')
      await button('重做').click(); await save()
      assert.equal((await read()).items[index].text, '第一行\n\n第二行 ABC！')
    }
    const stable = await read()
    await node(1).dblclick(); await editor().fill('取消的內容'); await editor().press('Escape'); await save()
    assert.deepEqual((await read()).items, stable.items, 'Escape discards the draft')
    await node(1).dblclick(); await editor().press('Escape'); await save()
    assert.equal((await read()).revision, stable.revision, 'Entering and cancelling must not save a revision')

    await node(1).dblclick()
    await editor().dispatchEvent('compositionstart', { data: '' })
    await editor().fill('中文組字')
    await editor().dispatchEvent('keydown', { key: 'Escape', isComposing: true })
    await editor().dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
    assert.equal(await editor().count(), 1, 'IME confirmation/cancel keys must stay inside the editor')
    await editor().dispatchEvent('compositionend', { data: '中文組字' })
    await save()
    assert.equal((await read()).items[1].text, '中文組字', 'Clicking Save commits the active editor')

    await node(0).dblclick(); await editor().fill('保留跨工作區內容')
    await page.evaluate(() => { window.location.hash = '/edgewhite' })
    await page.waitForSelector('.pl-inline-editor', { state: 'detached' })
    assert.equal((await read()).items[0].text, '保留跨工作區內容', 'Route flush commits without requiring a blur')
    await page.goto(base + '/#/prelayout'); await node(0).waitFor()
    assert.equal(await node(0).evaluate(el => el.firstChild.textContent), '保留跨工作區內容')

    await node(0).dblclick(); await editor().fill(''); await editor().press('Control+Enter'); await save()
    assert.equal((await read()).items[0].text, '', 'Empty text stays an editable item')
    assert.equal(await page.locator('.pl-text').count(), 3)
    await node(0).dblclick(); await editor().fill('空框仍可輸入'); await save()
    for (const text of ['行尾\n', '行尾\n\n', '\n', '\n\n', '甲\n\n乙']) {
      await node(0).dblclick(); await editor().fill(text)
      const html = await editor().innerHTML()
      await save()
      assert.equal((await read()).items[0].text, text, `Pasted blank lines must be exact: ${html}`)
      await node(0).dblclick(); await editor().press('Control+Enter'); await save()
      assert.equal((await read()).items[0].text, text, 'Reopening must preserve trailing lines')
    }
    await node(0).dblclick(); await editor().fill('行尾'); await editor().press('ControlOrMeta+End')
    await editor().press('Enter'); await editor().press('Enter'); await save()
    assert.equal((await read()).items[0].text, '行尾\n\n', 'Typed trailing lines must exclude the browser caret placeholder')
    await page.getByLabel('原圖對照', { exact: true }).check()
    await page.getByLabel('偵測框', { exact: true }).check()
    const source = page.locator('.pl-page[data-readonly="true"]')
    assert.equal(await source.locator('.pl-calculated-font').first().innerText(), '46.5')
    assert.equal(await source.locator('.pl-calculated-font').nth(1).innerText(), '—', 'Missing measurement must not invent a size')
    await node(1).click()
    await page.getByLabel('字級', { exact: true }).fill('52')
    await page.getByLabel('字級', { exact: true }).press('Tab'); await save()
    assert.equal(await node(1).locator('.pl-current-font').innerText(), '52')
    await node(1).dblclick(); await editor().waitFor()
    assert.equal(await node(1).locator('.pl-current-font').innerText(), '52')
    assert.equal(await source.locator('.pl-calculated-font').first().innerText(), '46.5')
    await page.screenshot({ path: path.join(output, 'font-size-comparison.png') })
    await editor().press('Escape')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks: ['horizontal/vertical/rotated geometry', 'line breaks and blank lines', 'selection and delete keys', 'single undo/redo', 'Escape cancellation', 'composition event guards', 'save and route flush', 'reload', 'empty item', 'current/calculated font sizes before and during editing'], errors }, null, 2))
    console.log('PASS inline text browser acceptance')
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    if (api) await page.request.delete(api)
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
