import { useState } from 'react'

const inpaintSteps = [
  ['點擊「新建項目」', '開啟 WebUI-6008 後，預設停留在漫畫修圖項目。點擊右上角「新建項目」，開始建立去字修復項目。', 'images/usage-entry-inpaint.png', '漫畫修圖項目頁面右上角的新建項目入口', 'compact'],
  ['填寫名稱並選圖', '輸入項目名稱，選擇漫畫原圖；Mask 可選。不清楚的設定維持預設即可，然後按「建立項目」。', 'images/usage-inpaint-create.png', '新建漫畫項目對話框：填寫名稱並選擇原圖', 'stack'],
  ['等待文字區域識別', '建立後會自動檢測缺少 Mask 的頁面。請等候文字區域識別完成，畫面會顯示已運行時間與預估剩餘時間。', 'images/usage-inpaint-detect.png', '準備與編輯步驟顯示文字區域識別進度', 'compact'],
  ['查看並修改識別結果', {
    lead: '左側是可編輯的 Mask／原圖，右側是即時填色預覽。識別結果可直接在畫面上修改。',
    keys: [
      { color: '#ffffff', label: '白色 · 純色填充', text: '氣泡等可直接塗白的區域。' },
      { color: '#ff6ea5', label: '粉紅色 · 待修補', text: '需交給模型修復的文字或複雜區域。' },
    ],
    rect: '先選 F1 純色填充或 F2 待修補，再拖出矩形。',
    section: '矩形框選',
    ops: [
      ['添加', '把框內加入當前類別。'],
      ['減去', '移除框內當前類別。'],
      ['右鍵框選', '清除框內兩類 Mask。'],
      ['Cmd／Ctrl＋右鍵', '把框內白色與粉紅色對調。'],
    ],
  }, 'images/usage-inpaint-mask.png', '識別完成後的 Mask 編輯畫面：左側白色為純色填充，粉紅色為待修補', 'stack'],
  ['點擊「下一步」', 'Mask 確認後，點擊右上角「下一步」，進入批量修復。', 'images/usage-inpaint-next.png', '準備與編輯步驟右上角的下一步按鈕', 'compact'],
  ['選擇修復方式並開始', '勾選要使用的修復流程，再按「開始批量修復」。可只選一套，也可多選；多套會依序執行。不清楚時維持預設即可。', 'images/usage-inpaint-batch.png', '批量修復頁面勾選流程並開始批量修復', 'stack'],
  ['等待修復結果', '開始後請等候任務完成，畫面會顯示已運行時間與進度。刷新網頁不會中斷後台任務。', 'images/usage-inpaint-running.png', '批量修復進行中，顯示已運行時間與進度', 'stack'],
  ['下載結果並進入合成', '全部完成後，可先按「下載候選結果」保存各套修復結果；再點「比較與局部合成」，進入合成頁面。', 'images/usage-inpaint-done.png', '全部完成後可下載候選結果，或進入比較與局部合成', 'compact'],
  ['用三種方式合成成品', {
    lead: '進入合成頁後，用右上角選單切換比較方式。三種方式都能組出想要的圖，切換不會丟掉已挑選的結果。',
    menu: {
      src: 'images/usage-inpaint-compose-menu.png',
      alt: '比較模式選單：多圖對比、整體＋局部、區域卡片',
    },
    methods: [
      {
        label: '多圖對比',
        text: '並排查看合成結果與各套修復，適合整頁比較。',
        src: 'images/usage-inpaint-compose-multi.png',
        alt: '多圖對比：並排查看合成結果與各套修復',
      },
      {
        label: '整體＋局部',
        text: '上方看整頁，下方逐區比較，點選採用該區域。',
        src: 'images/usage-inpaint-compose-context.png',
        alt: '整體＋局部：上方整頁，下方逐區挑選候選',
      },
      {
        label: '區域卡片',
        text: '把各修補區域排成卡片，合成結果可拖動對照。',
        src: 'images/usage-inpaint-compose-cards.png',
        alt: '區域卡片：各修補區域排成卡片，合成結果可拖動',
      },
    ],
  }],
  ['確認後導出結果', '每一頁確認完成後，「待確認」會變成 0。此時按右上角「導出結果」，即可下載成品。', 'images/usage-inpaint-export.png', '待確認為 0 時，可按右上角導出結果', 'compact'],
]

const letteringSteps = [
  ['點擊「預排版」', '開啟 WebUI-6008 後，點擊頂部「預排版」，進入 LabelPlus 預排版工作台。', 'images/usage-entry-prelayout.png', '漫畫修圖項目頁面頂部的預排版入口', 'compact'],
  ['選擇圖片並命名', '輸入項目名稱，再選擇漫畫原圖或資料夾。資料夾只讀第一層；圖片與進度保存在預排版專用項目。', 'images/usage-prelayout-create.png', '新建預排版項目對話框，可輸入名稱並選擇圖片', 'compact'],
  ['進行文字識別', '匯入完成後會詢問是否進行 CTD 識別，用來取得文字框與字級。識別需要一些時間，右側「偵測與字級」會顯示進度。', [
    ['images/usage-prelayout-ctd.png', '圖片匯入後詢問是否進行 CTD 識別'],
    ['images/usage-prelayout-progress.png', '右側偵測與字級面板顯示識別進度'],
  ], null, 'pair'],
  ['查看文字資訊', '識別完成後，打開上方「原圖對照」「去字底圖」「偵測框」，即可對照原圖與文字框資訊。此步只需查看。', 'images/usage-prelayout-inspect.png', '打開原圖對照、去字底圖與偵測框以查看文字資訊', 'stack'],
  ['匯入 LabelPlus.txt', '點擊「匯入LP.txt」，匯入對應的譯文稿。若已有完成的 CTD 結果，會自動匹配本次頁面。', 'images/usage-prelayout-import.png', '工具列上的匯入 LP.txt 入口', 'compact'],
  ['查看初步排版', '匯入後即可看到譯文已套上位置、字級與樣式的初步排版，之後可再微調。', 'images/usage-prelayout-result.png', '匯入譯文後的初步排版與原稿對照', 'stack'],
  ['調整文字框', '點選文字後，可左右拖曳調整位置；畫面上的＋／－與旋轉鈕，或快捷鍵，都能改字級與方向。右側可修改文字內容、顏色，並加上描邊。', 'images/usage-prelayout-edit.png', '選中文字框後，可拖曳位置並在右側修改內容、顏色與描邊', 'stack'],
  ['下載 Meo.json 與腳本', '全部調整完成後，下載 Meo.json 與配套 PS 腳本，並把 Meo.json 放到原圖資料夾中。', 'images/usage-prelayout-export.png', '工具列上的匯出 Meo.json 與配套 PS 腳本入口', 'compact'],
  ['在 Photoshop 生成 PSD', '將配套腳本壓縮包解壓。開啟 Photoshop，選擇「檔案 → 指令碼 → 瀏覽」，執行解壓後的 LabelPlus_Ps_Script_ZS.jsx。在「Meo格式文本」選取已放到原圖資料夾的 Meo.json；塗白文件夾請選擇已經完成去字修復的圖片。執行後即可依先前排版生成 PSD。', [
    ['images/usage-prelayout-ps.png', 'LabelPlus PS 腳本視窗中選擇 Meo.json'],
    ['images/usage-prelayout-ps-clean.png', '塗白文件夾需選擇已完成去字修復的圖片'],
  ], null, 'stack'],
]

const edgeWhiteSteps = [
  ['點擊「邊緣塗白」', '開啟 WebUI-6008 後，點擊頂部「邊緣塗白」，進入邊緣塗白工作台並上傳漫畫圖片。', 'images/usage-entry-edgewhite.png', '漫畫修圖項目頁面頂部的邊緣塗白入口'],
  ['從四周拉出分割線', '從頁面四邊拖出分割線。每個方向都可以依需求拉多條，用來隔開頁眉、頁腳、黑邊或其他多餘資訊。', 'images/usage-edgewhite-guides.png', '從漫畫頁面四周拉出水平與垂直分割線'],
  ['尋找合適位置', '點擊頂部方向按鈕，讓分割線吸附到附近的空白分界。也可以用滑鼠拖曳，或 Option／Alt + 方向鍵微調；右側會即時預覽。', 'images/usage-edgewhite-snap.png', '使用方向按鈕讓分割線找到合適位置'],
  ['點選區域塗白', '點擊分割後的區域即可塗白該處；再點一次即可取消。', 'images/usage-edgewhite-fill.png', '點選分割區域塗白，右側顯示輸出預覽'],
  ['保存與下載', '確認本頁後按「保存並下一頁」。全部頁面完成後，再下載整批結果。', 'images/usage-edgewhite-save.png', '保存並下一頁與下載整批結果按鈕'],
]

const tabs = {
  inpaint: {
    label: '漫畫去字修復',
    kicker: 'COMIC INPAINT',
    title: '清除漫畫文字，保留完整畫面。',
    intro: '自動檢測修補範圍，依序執行多套修復流程，再挑選最合適的結果。',
    effectTitle: '漫畫去字修復效果',
    effectDescription: '同一組漫畫依序比較原圖與三套修復結果。粉紅色區域代表需要處理的位置。',
    flowTitle: '漫畫去字修復使用方式',
    flowDescription: '從工作台「新建項目」進入，完成檢測、修復、比較與成品導出。',
    steps: inpaintSteps,
  },
  lettering: {
    label: 'LabelPlus 預排版',
    kicker: 'LABELPLUS PRELAYOUT',
    title: '快速為 LabelPlus 翻譯稿進行基礎排版。',
    intro: '自動匹配原文字的大小、顏色與描邊，讓譯文在氣泡內居中。手動編輯後生成 PSD。',
    effectTitle: 'LabelPlus 預排版效果',
    effectDescription: '匯入譯文後自動匹配文字屬性，在連續畫布中快速檢查前後頁。',
    flowTitle: 'LabelPlus 預排版使用方式',
    flowDescription: '從工作台「預排版」進入，識別文字、匯入譯文並微調後，完成初步排版。',
    steps: letteringSteps,
  },
  edgewhite: {
    label: '邊緣塗白',
    kicker: 'EDGE WHITE',
    title: '清理漫畫四邊的無用資訊。',
    intro: '用參考線尋找空白分界，保留正文與伸出畫框的內容，逐格清理頁面邊緣。',
    effectTitle: '邊緣塗白效果',
    effectDescription: '左側放置參考線並選取網格，右側即時預覽塗白結果；保持原尺寸，只塗白選中格子。',
    flowTitle: '邊緣塗白使用方式',
    flowDescription: '從工作台「邊緣塗白」進入，拉線、吸附、點選塗白後保存下載。',
    steps: edgeWhiteSteps,
  },
}

function getShots(image, alt) {
  if (!image) return []
  if (Array.isArray(image)) {
    return image.map((item) => (Array.isArray(item) ? { src: item[0], alt: item[1] } : item))
  }
  return [{ src: image, alt }]
}

function shotHref(src) {
  return `${import.meta.env.BASE_URL}${src}`
}

function StepDetail({ detail }) {
  if (typeof detail === 'string') return <p>{detail}</p>

  return (
    <div className="step-guide">
      {detail.lead ? <p>{detail.lead}</p> : null}
      {detail.menu ? (
        <a className="step-menu-shot" href={shotHref(detail.menu.src)} target="_blank" rel="noreferrer">
          <img src={shotHref(detail.menu.src)} alt={detail.menu.alt} />
        </a>
      ) : null}
      {detail.keys?.length ? (
        <ul className="step-keys">
          {detail.keys.map((item) => (
            <li key={item.label}>
              {item.color ? <span className="step-key-swatch" style={{ background: item.color }} aria-hidden="true" /> : null}
              <div>
                <strong>{item.label}</strong>
                <span>{item.text}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {detail.ops ? (
        <div className="step-ops">
          {detail.section ? <p>{detail.section}</p> : null}
          {detail.rect ? <p>{detail.rect}</p> : null}
          <dl>
            {detail.ops.map(([term, desc]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {detail.methods ? (
        <ol className="step-methods">
          {detail.methods.map((method, index) => (
            <li key={method.label}>
              <div className="step-method-copy">
                <span>方式 {String(index + 1).padStart(2, '0')}</span>
                <h4>{method.label}</h4>
                <p>{method.text}</p>
              </div>
              <a className="step-method-shot" href={shotHref(method.src)} target="_blank" rel="noreferrer">
                <img src={shotHref(method.src)} alt={method.alt} />
              </a>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

function Steps({ items }) {
  const illustrated = items.filter((item) => item[2] || (typeof item[1] === 'object' && item[1]?.methods)).length > 1

  return (
    <ol className={illustrated ? 'step-list illustrated' : 'step-list'}>
      {items.map(([title, detail, image, alt, fit], index) => {
        const shots = getShots(image, alt)
        const hasMethods = typeof detail === 'object' && detail?.methods
        const layout = hasMethods ? 'stack' : fit || (shots.length > 1 ? 'pair' : undefined)
        const itemClass = [
          shots.length || hasMethods ? 'has-shot' : '',
          layout ? `shot-${layout}` : '',
          hasMethods ? 'shot-methods' : '',
        ].filter(Boolean).join(' ') || undefined

        return (
          <li key={title} className={itemClass}>
            <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
            <div className="step-copy">
              <h3>{title}</h3>
              <StepDetail detail={detail} />
            </div>
            {shots.length ? (
              <div className={['step-shots', layout].filter(Boolean).join(' ')}>
                {shots.map((shot) => (
                  <a key={shot.src} href={shotHref(shot.src)} target="_blank" rel="noreferrer">
                    <img src={shotHref(shot.src)} alt={shot.alt} />
                  </a>
                ))}
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function InpaintEffect() {
  return (
    <figure className="result-figure">
      <a href={`${import.meta.env.BASE_URL}images/inpaint-comparison.jpg`} target="_blank" rel="noreferrer">
        <img
          src={`${import.meta.env.BASE_URL}images/inpaint-comparison.jpg`}
          alt="原圖修復位置與 Flux 2 Klein、FireRed、Qwen Image Edit 三套漫畫去字效果比較"
        />
      </a>
      <figcaption>
        <span>實際處理對比</span>
        <p>左起：原圖＋修復位置高亮、Flux 2 Klein、FireRed、Qwen Image Edit。</p>
        <small>點擊放大 ↗</small>
      </figcaption>
    </figure>
  )
}

function LetteringEffect() {
  return (
    <div className="lettering-stage">
      <a className="lettering-preview" href={`${import.meta.env.BASE_URL}images/prelayout-effect.jpg`} target="_blank" rel="noreferrer">
        <img
          src={`${import.meta.env.BASE_URL}images/prelayout-effect.jpg`}
          alt="漫畫預排版連續畫布，左側顯示原稿，右側顯示匹配位置與樣式後的文字框"
        />
        <span>點擊查看原尺寸 ↗</span>
      </a>
      <aside>
        <p>自動匹配內容</p>
        <ul>
          <li>文字大小與中點位置</li>
          <li>文字顏色與描邊設定</li>
          <li>連續畫布集中調整屬性</li>
          <li>配套腳本生成 PSD</li>
        </ul>
      </aside>
    </div>
  )
}

function EdgeWhiteEffect() {
  return (
    <figure className="result-figure">
      <a href={`${import.meta.env.BASE_URL}images/edgewhite-effect.png`} target="_blank" rel="noreferrer">
        <img
          src={`${import.meta.env.BASE_URL}images/edgewhite-effect.png`}
          alt="邊緣塗白工作台：左側編輯畫面放置參考線，右側即時顯示塗白輸出預覽"
        />
      </a>
      <figcaption>
        <span>實際處理對比</span>
        <p>左為編輯畫面與參考線，右為保持原尺寸的塗白輸出預覽。</p>
        <small>點擊放大 ↗</small>
      </figcaption>
    </figure>
  )
}

function AutoDLSection({ activeTab }) {
  if (activeTab !== 'inpaint') {
    const isLettering = activeTab === 'lettering'
    return (
      <section className="chapter autodl-chapter" id="autodl">
        <div className="chapter-heading">
          <span>02</span>
          <div><p>EXISTING INSTANCE</p><h2>使用既有實例</h2></div>
          <p>三個工具已整合在同一個 WebUI-6008，建立一次即可使用全部功能。</p>
        </div>
        <ol className="autodl-steps">
          <li>
            <div className="autodl-step-copy">
              <span>READY TO USE</span>
              <h3>無需重新建立或配置</h3>
              <p>若已依照「漫畫去字修復」建立 AutoDL 實例，無需重新建立實例、選擇顯卡或配置環境。</p>
              <p>直接從 WebUI-6008 切換到「{isLettering ? 'LabelPlus 預排版' : '邊緣塗白'}」即可使用。</p>
              {isLettering ? (
                <aside>若只使用 LabelPlus 預排版，普通 NVIDIA 顯卡即可；推薦使用個人電腦私有化部署，減少長期租用雲端顯卡的費用。</aside>
              ) : (
                <aside>邊緣塗白本身不使用 GPU；推薦使用個人電腦私有化部署，日常使用更省錢。</aside>
              )}
            </div>
            <div className="autodl-shots">
              <a href={`${import.meta.env.BASE_URL}images/autodl-webui.png`} target="_blank" rel="noreferrer">
                <img src={`${import.meta.env.BASE_URL}images/autodl-webui.png`} alt="AutoDL 運行中的實例與 WebUI-6008 入口" />
              </a>
            </div>
          </li>
        </ol>
      </section>
    )
  }

  return (
    <section className="chapter autodl-chapter" id="autodl">
      <div className="chapter-heading">
        <span>02</span>
        <div><p>FIRST START</p><h2>建立 AutoDL 實例</h2></div>
        <p>從社區鏡像建立實例，選好顯卡並開機，大約一分鐘後即可進入日漫嵌字好幫手。</p>
      </div>
      <a className="autodl-entry" href="https://www.autodl.art/app/market" target="_blank" rel="noreferrer">
        前往 AutoDL 鏡像市場 <span>autodl.art/app/market ↗</span>
      </a>
      <ol className="autodl-steps">
        <li>
          <div className="autodl-step-copy">
            <span>STEP 01</span>
            <h3>選擇社區鏡像</h3>
            <p>點擊「使用非應用鏡像創建」，切換到「社區鏡像」，搜尋 <code>comic</code>。</p>
            <p>選擇 <strong>ZsIsMe/comic-lettering-helper/comic-lettering-helper</strong>。</p>
          </div>
          <div className="autodl-shots two">
            <a href={`${import.meta.env.BASE_URL}images/autodl-create-instance.png`} target="_blank" rel="noreferrer">
              <img src={`${import.meta.env.BASE_URL}images/autodl-create-instance.png`} alt="AutoDL 建立實例頁面中的使用非應用鏡像創建入口" />
            </a>
            <a href={`${import.meta.env.BASE_URL}images/autodl-community-image.png`} target="_blank" rel="noreferrer">
              <img src={`${import.meta.env.BASE_URL}images/autodl-community-image.png`} alt="在 AutoDL 社區鏡像搜尋 comic 並選擇日漫嵌字好幫手鏡像" />
            </a>
          </div>
        </li>
        <li>
          <div className="autodl-step-copy">
            <span>STEP 02</span>
            <h3>選擇 32 GB 以上顯存</h3>
            <p>推薦 <strong>4080(S)-32G</strong>，價格與速度較均衡；<strong>5090-32G</strong> 速度更快。</p>
            <p>北京 B 區或西北 B 區皆可，依當時庫存選擇。<strong>無需擴容</strong>，直接建立並開機。</p>
          </div>
          <div className="autodl-shots two">
            <a href={`${import.meta.env.BASE_URL}images/autodl-gpu-beijing.png`} target="_blank" rel="noreferrer">
              <img src={`${import.meta.env.BASE_URL}images/autodl-gpu-beijing.png`} alt="AutoDL 北京 B 區的 32 GB 以上 GPU 選項" />
            </a>
            <a href={`${import.meta.env.BASE_URL}images/autodl-gpu-northwest.png`} target="_blank" rel="noreferrer">
              <img src={`${import.meta.env.BASE_URL}images/autodl-gpu-northwest.png`} alt="AutoDL 西北 B 區的 32 GB 以上 GPU 選項" />
            </a>
          </div>
        </li>
        <li>
          <div className="autodl-step-copy">
            <span>STEP 03</span>
            <h3>從 WebUI-6008 進入</h3>
            <p>實例開機後等待約一分鐘，點擊「WebUI-6008」進入日漫嵌字好幫手。</p>
            <aside><strong>順便一提</strong>：WebUI-6006 是對應的 ComfyUI 介面，裡面也提供單張操作的工作流。</aside>
          </div>
          <div className="autodl-shots">
            <a href={`${import.meta.env.BASE_URL}images/autodl-webui.png`} target="_blank" rel="noreferrer">
              <img src={`${import.meta.env.BASE_URL}images/autodl-webui.png`} alt="AutoDL 運行中的實例與 WebUI-6008 入口" />
            </a>
          </div>
        </li>
      </ol>
    </section>
  )
}

export default function App() {
  const [activeTab, setActiveTab] = useState('inpaint')
  const active = tabs[activeTab]

  function selectTab(key) {
    setActiveTab(key)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="返回頁首">
          <span className="brand-mark">漫</span>
          <span>日漫嵌字好幫手<small>操作指南</small></span>
        </a>
        <nav className="tool-tabs" aria-label="功能選擇">
          {Object.entries(tabs).map(([key, tab]) => (
            <button
              key={key}
              type="button"
              className={activeTab === key ? 'active' : ''}
              aria-pressed={activeTab === key}
              onClick={() => selectTab(key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <a className="github-link" href="https://github.com/ZsIsMe/comic-lettering-helper">GitHub ↗</a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="kicker">{active.kicker} · START HERE</p>
          <h1>{active.title}</h1>
          <p className="hero-intro">{active.intro}</p>
          <a className="primary-link" href="#effect">開始閱讀 <span>↓</span></a>
        </div>
        <div className="hero-index" aria-label="本頁內容">
          <p>{active.label} · 本頁內容</p>
          <a href="#effect"><b>01</b><span><strong>效果</strong><small>查看實際用途與處理結果</small></span></a>
          <a href="#autodl">
            <b>02</b>
            <span>
              <strong>{activeTab === 'inpaint' ? '建立 AutoDL 實例' : '使用既有實例'}</strong>
              <small>{activeTab === 'inpaint' ? '從社區鏡像開啟工作台' : '無需重新建立或配置環境'}</small>
            </span>
          </a>
          <a href="#usage"><b>03</b><span><strong>使用方式</strong><small>跟著步驟完成整套操作</small></span></a>
        </div>
      </section>

      <section className={`chapter result-chapter ${activeTab === 'lettering' ? 'lettering-result' : ''}`} id="effect">
        <div className="chapter-heading">
          <span>01</span>
          <div><p>RESULT / {active.kicker}</p><h2>{active.effectTitle}</h2></div>
          <p>{active.effectDescription}</p>
        </div>
        {activeTab === 'inpaint' && <InpaintEffect />}
        {activeTab === 'lettering' && <LetteringEffect />}
        {activeTab === 'edgewhite' && <EdgeWhiteEffect />}
      </section>

      <AutoDLSection activeTab={activeTab} />

      <section className={`chapter flow-chapter ${activeTab === 'lettering' ? 'alternate' : ''}`} id="usage">
        <div className="chapter-heading">
          <span>03</span>
          <div><p>HOW TO / {active.kicker}</p><h2>{active.flowTitle}</h2></div>
          <p>{active.flowDescription}</p>
        </div>
        <Steps items={active.steps} />
      </section>

      <footer>
        <div><span className="brand-mark">漫</span><strong>日漫嵌字好幫手</strong></div>
        <p>這是一份面向使用者的操作指南，內容與圖片將持續補充。</p>
        <a href="#top">回到頁首 ↑</a>
      </footer>
    </main>
  )
}
