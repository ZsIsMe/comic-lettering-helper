const chapters = [
  { no: '01', href: '#inpaint-result', title: '漫畫去字效果', note: '看處理前後的實際差異' },
  { no: '02', href: '#lettering-result', title: '預排版效果', note: '了解譯文如何落到漫畫頁面' },
  { no: '03', href: '#autodl', title: '建立 AutoDL 實例', note: '從零開啟你的工作台' },
  { no: '04', href: '#inpaint-flow', title: '漫畫去字流程', note: '準備、修復、挑選、導出' },
  { no: '05', href: '#lettering-flow', title: '預排版流程', note: '匯入、調整、導出' },
]

const inpaintSteps = [
  ['建立項目', '放入要處理的漫畫原圖；有 Mask 也可以一起上傳。'],
  ['準備修補範圍', '使用自動檢測，再依需要以畫筆或選區調整。'],
  ['開始批量修復', '選擇修復方式，工作台會逐頁處理並保存進度。'],
  ['比較與導出', '挑選合適的候選，確認全部頁面後下載成品。'],
]

const letteringSteps = [
  ['建立預排版', '上傳漫畫原圖，建立獨立的排版項目。'],
  ['匯入並匹配譯文', '開啟 Meo.json 或匯入 LabelPlus 文字稿，匹配字級、顏色、中點位置與描邊。'],
  ['在連續畫布調整', '直接查看前後頁，微調文字位置、字級、方向、旋轉與樣式。'],
  ['生成 PSD', '導出 Meo.json，再使用配套 Photoshop 腳本生成可繼續編輯的 PSD。'],
]

function ImagePlaceholder({ eyebrow, title, detail, tone = 'warm' }) {
  return (
    <div className={`image-placeholder ${tone}`}>
      <span>{eyebrow}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
      <small>圖片素材待補</small>
    </div>
  )
}

function Steps({ items }) {
  return (
    <ol className="step-list">
      {items.map(([title, detail], index) => (
        <li key={title}>
          <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
          <div>
            <h3>{title}</h3>
            <p>{detail}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

export default function App() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="返回頁首">
          <span className="brand-mark">漫</span>
          <span>漫畫去字工作台<small>操作指南</small></span>
        </a>
        <nav aria-label="主要章節">
          {chapters.map(item => <a key={item.no} href={item.href}>{item.no}</a>)}
        </nav>
        <a className="github-link" href="https://github.com/ZsIsMe/comic-lettering-helper">GitHub ↗</a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="kicker">COMIC WORKSPACE · START HERE</p>
          <h1>使用強大的圖像編輯模型和AI工具，<br />完成漫畫去字與預排版。</h1>
          <p className="hero-intro">從建立 AutoDL 實例開始，跟著圖片和簡單步驟完成整套操作。</p>
          <a className="primary-link" href="#inpaint-result">開始閱讀 <span>↓</span></a>
        </div>
        <div className="hero-index" aria-label="本頁內容">
          <p>本頁內容</p>
          {chapters.map(item => (
            <a key={item.no} href={item.href}>
              <b>{item.no}</b>
              <span><strong>{item.title}</strong><small>{item.note}</small></span>
            </a>
          ))}
        </div>
      </section>

      <section className="chapter result-chapter" id="inpaint-result">
        <div className="chapter-heading">
          <span>01</span>
          <div><p>RESULT / INPAINT</p><h2>漫畫去字效果</h2></div>
          <p>同一組漫畫依序比較原圖與三套修復結果。粉紅色區域代表需要處理的位置，點擊圖片可查看原尺寸。</p>
        </div>
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
      </section>

      <section className="chapter lettering-result" id="lettering-result">
        <div className="chapter-heading">
          <span>02</span>
          <div><p>RESULT / LETTERING</p><h2>預排版效果</h2></div>
          <p>自動匹配原文字的大小、顏色、中點位置與描邊，再到連續畫布中快速檢查和調整。</p>
        </div>
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
      </section>

      <section className="chapter autodl-chapter" id="autodl">
        <div className="chapter-heading">
          <span>03</span>
          <div><p>FIRST START</p><h2>如何在 AutoDL 建立實例</h2></div>
          <p>從社區鏡像建立實例，選好顯卡並開機，大約一分鐘後即可進入漫畫工作台。</p>
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
                <img src={`${import.meta.env.BASE_URL}images/autodl-community-image.png`} alt="在 AutoDL 社區鏡像搜尋 comic 並選擇漫畫工作台鏡像" />
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
              <p>實例開機後等待約一分鐘，點擊「WebUI-6008」進入漫畫工作台。</p>
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

      <section className="chapter flow-chapter" id="inpaint-flow">
        <div className="chapter-heading">
          <span>04</span>
          <div><p>HOW TO / INPAINT</p><h2>漫畫去字流程</h2></div>
          <p>每一步只說明使用者要做的動作；模型與技術設定留在工作台內處理。</p>
        </div>
        <Steps items={inpaintSteps} />
      </section>

      <section className="chapter flow-chapter alternate" id="lettering-flow">
        <div className="chapter-heading">
          <span>05</span>
          <div><p>HOW TO / LETTERING</p><h2>預排版流程</h2></div>
          <p>從漫畫與譯文開始，在瀏覽器中完成初步文字配置。</p>
        </div>
        <Steps items={letteringSteps} />
      </section>

      <footer>
        <div><span className="brand-mark">漫</span><strong>漫畫去字工作台</strong></div>
        <p>這是一份面向使用者的操作指南，內容與圖片將持續補充。</p>
        <a href="#top">回到頁首 ↑</a>
      </footer>
    </main>
  )
}
