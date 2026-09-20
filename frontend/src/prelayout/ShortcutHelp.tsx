import { useId, useState } from 'react'
import { shortcutHelpGroups } from './shortcuts'
import './ShortcutHelp.css'

type ShortcutHelpProps = {
  collapsible?: boolean
  defaultOpen?: boolean
}

function HelpContent() {
  const headingPrefix = useId()
  return <>
    <p className="pl-shortcut-guide__intro">
      Mac 使用 ⌘／Option，Windows 使用 Ctrl／Alt。先選取文字再操作；原圖像素不受畫面縮放影響。
      樣式與幾何調整可套用至多個已選框，複製一次只接受一框；連續長按同一調整可一次撤銷。
    </p>
    <div className="pl-shortcut-guide__scroll">
      <div className="pl-shortcut-guide__groups">
        {shortcutHelpGroups.map(group => <section key={group.title} className="pl-shortcut-guide__group" aria-labelledby={`${headingPrefix}-${group.title}`}>
          <h3 id={`${headingPrefix}-${group.title}`}>{group.title}</h3>
          <dl>
            {group.items.map(([action, keys]) => <div key={action}>
              <dt>{action}</dt>
              <dd>{keys}</dd>
            </div>)}
          </dl>
        </section>)}
      </div>
    </div>
    <p className="pl-shortcut-guide__note">輸入框、中文組字、彈窗及拖曳期間不觸發頁面快捷鍵。</p>
  </>
}

export function ShortcutHelp({ collapsible = true, defaultOpen = true }: ShortcutHelpProps) {
  const [open, setOpen] = useState(defaultOpen)
  if (!collapsible) return <div className="pl-shortcut-guide"><HelpContent /></div>
  return <details className="pl-shortcut-guide pl-shortcut-guide--top" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span>快捷鍵與滑鼠操作</span>
      <small>完整操作表</small>
    </summary>
    <HelpContent />
  </details>
}
