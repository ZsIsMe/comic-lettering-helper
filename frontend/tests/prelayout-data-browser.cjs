const {chromium}=require(process.env.PRELAYOUT_PLAYWRIGHT || 'playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const base=process.env.PRELAYOUT_TEST_URL || 'http://127.0.0.1:6018', output=path.resolve(process.env.PRELAYOUT_TEST_OUTPUT || 'var-test/prelayout-browser');
const fixture=JSON.parse(fs.readFileSync(path.join(output,'fixture.json')));const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(!await fn()){if(Date.now()-start>15000)throw new Error('Timeout: '+label);await pause(100)}}
;(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PRELAYOUT_CHROME?{executablePath:process.env.PRELAYOUT_CHROME}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
 const button=text=>page.getByRole('button',{name:new RegExp('^'+text.split('').join('\\s*')+'$')});
 const saved=async()=>{await button('保存').click();await until(async()=>await page.locator('.pl-title .ant-tag').innerText()==='已保存','save')};
 let createdId;
 try{
  await page.route('**/api/prelayout/availability',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({methods:{single_char:false,ocr_aligned:false},assets:{font:false,ctd:false,ocr:false,alphabet:false,metrics:false},runtime:false,gpu_owner:null})}));
  await page.goto(base+'/#/prelayout');await button('新建預排版').click();
  await page.getByPlaceholder('項目名稱').fill('瀏覽器資料流程（合成）');
  await page.locator('.ant-modal:visible input[type=file][accept=".png,.jpg,.jpeg"]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:fs.readFileSync(path.join(output,'sample.png'))});
  await button('建立項目').click();await page.locator('.pl-page').waitFor();
  createdId=await page.evaluate(()=>localStorage.getItem('pl-last-project'));assert(createdId&&createdId!==fixture.id);
  await page.getByText('目前使用系統替代字型。',{exact:false}).waitFor();
  await page.setViewportSize({width:600,height:900});await pause(300);assert.equal(await page.locator('.pl-pages-nav').isVisible(),true);assert((await page.locator('.pl-viewport').boundingBox()).width>=300);await page.screenshot({path:path.join(output,'narrow-editor.png')});await page.setViewportSize({width:1440,height:1000});
  const api=base+'/api/prelayout/projects/'+createdId;const record=await (await page.request.get(api)).json();const pid=record.pages[0].id;
  const read=async()=> (await page.request.get(api+'/pages/'+pid)).json();
  await page.locator('.pl-page').dblclick({position:{x:150,y:200}});await page.locator('.pl-text').waitFor();await saved();
  assert.equal((await read()).items.length,1);
  await button('開啟 Meo.json').click();await page.locator('.pl-tool-row input[type=file]').setInputFiles(path.join(output,'sample_bt.json'));
  await page.getByRole('dialog').filter({hasText:'確認匯入譯稿'}).waitFor();await button('匯入').click();await until(async()=>await page.locator('.pl-text').count()===35,'BT imported');
  await page.locator('.pl-text').first().click();
  await page.locator('.pl-inspector textarea').fill('編輯\n換行');await saved();let local=await read();const id=local.items[0]._id;assert.equal(local.items[0].text,'編輯\n換行');
  await button('加入常用框').click();await page.getByText('常用文字框',{exact:true}).click();await until(async()=>await page.locator('.pl-clipboard').count()>=1,'persistent clipboard');
  const count=local.items.length;await page.locator('.pl-clipboard > button').first().click();assert.equal((await read()).items.length,count,'Clicking the list only copies');
  // A stale tab must preserve its local text instead of overwriting a newer revision.
  const remote=structuredClone(local.items);remote[0].text='另一分頁版本';
  const external=await page.request.patch(api+'/pages/'+pid+'/text',{data:{items:remote,expected_revision:local.revision,operation_id:'external-edit'}});assert.equal(external.status(),200);
  await page.locator('.pl-inspector textarea').fill('我的草稿');await button('保存').click();
  await button('保留我的草稿').waitFor();assert.equal((await read()).items[0].text,'另一分頁版本');assert.equal(await page.locator('.pl-inspector textarea').inputValue(),'我的草稿');
  await button('保留我的草稿').click();await saved();assert.equal((await read()).items[0].text,'我的草稿');
  // Server failure keeps the browser draft. Reload restores it and retry succeeds.
  await page.route('**/api/prelayout/projects/*/pages/*/text',r=>r.fulfill({status:503,contentType:'application/json',body:'{"detail":"合成保存失敗"}'}));
  await page.locator('.pl-inspector textarea').fill('失敗後保留');await button('保存').click();await page.getByText('合成保存失敗',{exact:true}).waitFor();await pause(200);
  page.on('dialog',dialog=>dialog.accept());await page.reload();await page.locator('.pl-text').first().waitFor();
  await page.locator(`[data-item="${id}"]`).click();assert.equal(await page.locator('.pl-inspector textarea').inputValue(),'失敗後保留');
  await page.unroute('**/api/prelayout/projects/*/pages/*/text');await saved();assert.equal((await read()).items[0].text,'失敗後保留');
  // Model-free LabelPlus import retains the outside group and labels drafts unmatched.
  const lp='1, 0\n-\n對話\n框外\n-\n備註\n>>>>>>>>[001.png]<<<<<<<<\n----------------[1]----------------[0.5,0.3,1]\n對話內容\n----------------[2]----------------[0.6,0.3,2]\n音效\n';
  await button('匯入LP.txt').click();await page.locator('.pl-tool-row input[type=file]').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from(lp)});await button('匯入').click();await until(async()=>await page.locator('.pl-text').count()===2,'LabelPlus imported');
  local=await read();assert.deepEqual(local.items.map(i=>i.groupId),[0,1]);assert(local.items.every(i=>i.match_status==='unmatched'));
  await button('下一個待處理').click();assert.equal(await page.locator('.pl-text.selected').count(),1);
  await button('上傳去字圖').click();await page.locator('.pl-tool-row input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:fs.readFileSync(path.join(output,'sample.png'))});
  await until(async()=>!!(await (await page.request.get(api)).json()).pages[0].clean,'clean image paired');
  assert.equal(await button('導出項目').count(),0);
  const event=page.waitForEvent('download');await button('匯出 Meo.json').click();const download=await event;assert.equal(download.suggestedFilename(),'Meo.json');const bt=path.join(output,'Meo.json');await download.saveAs(bt);
  const exported=JSON.parse(fs.readFileSync(bt));assert.deepEqual(exported.transMap['001.png'].map(i=>i.groupId),[0,1]);
  await button('開啟 Meo.json').click();await page.locator('.pl-tool-row input[type=file]').setInputFiles(bt);await button('匯入').click();
  await until(async()=>!await page.locator('.ant-modal-wrap:visible').count(),'BT roundtrip');
  const imported=await(await page.request.get(api)).json();const items=(await read()).items;
  assert.equal(items.length,2);assert(imported.pages[0].clean);
  await button('項目列表').click();const card=page.locator('.pl-project-card').filter({hasText:'瀏覽器資料流程（合成）'});await card.getByRole('button',{name:/改\s*名/}).click();
  await page.locator('.ant-modal:visible input').fill('重新命名（合成）');await page.locator('.ant-modal:visible .ant-btn-primary').click();
  const renamed=page.locator('.pl-project-card').filter({hasText:'重新命名（合成）'});await renamed.waitFor();await renamed.getByRole('button',{name:/刪\s*除/}).click();await page.locator('.ant-modal:visible .ant-btn-primary').click();await renamed.waitFor({state:'detached'});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'data-browser-report.json'),JSON.stringify({passed:true,errors,checks:['create','missing-font/model manual editing','600px viewport','BT import','edit','persistent clipboard','conflict resolution','failed save/draft recovery','LabelPlus groups','pending jump','clean pairing','BT-only export and roundtrip','rename','delete']},null,2));console.log('PASS data browser flow');
 }catch(e){await page.screenshot({path:path.join(output,'data-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'data-browser-report.json'),JSON.stringify({passed:false,error:String(e),errors,createdId},null,2));throw e}finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
