import { Checkbox, Form, InputNumber, Select } from 'antd'
import type { DetectionOptions } from './workbench-api'

export function DetectionSettings({ value, onChange, disabled = false }: {
  value: DetectionOptions
  onChange: (value: DetectionOptions) => void
  disabled?: boolean
}) {
  return (
      <Form layout="vertical" className="detection-settings" disabled={disabled}>
        <div className="detection-settings-grid">
          <Form.Item label="Mask 膨脹尺寸" tooltip="擴大文字 Mask，連接文字碎片；0 表示不膨脹。">
            <InputNumber aria-label="Mask 膨脹尺寸" min={0} max={64} precision={0} addonAfter="px" value={value.mask_dilate}
              onChange={v => onChange({ ...value, mask_dilate: v ?? 0 })} />
          </Form.Item>
          <Form.Item label="塗白範圍">
            <Select aria-label="塗白範圍" value={value.mask_mode} onChange={v => onChange({ ...value, mask_mode: v })}
              options={[{value:'text_onomatopoeia',label:'文字＋狀聲詞'},{value:'text',label:'僅文字'},{value:'onomatopoeia',label:'僅狀聲詞'},{value:'all',label:'全部四類（含氣泡、分格）'}]} />
          </Form.Item>
        </div>
        {value.mask_mode === 'all' && <p className="detection-setting-note">此範圍也會選中氣泡與分格區域。</p>}
        <Form.Item className="detection-bubble-toggle">
          <Checkbox checked={value.bubble_enabled} onChange={e => onChange({ ...value, bubble_enabled: e.target.checked })}>辨識氣泡內外，擴展純色氣泡填充</Checkbox>
        </Form.Item>
        <p className="detection-setting-note">氣泡內可局部取樣，氣泡外檢查四周；關閉後全部檢查四周。擴展失敗會保留原有局部填充。</p>
        <Form.Item className="detection-bubble-shrink" label="氣泡內縮（每個氣泡短邊）" tooltip="預設 2%；這是邊框保留寬度，不是純色靈敏度。">
          <InputNumber aria-label="氣泡內縮百分比" min={0} max={10} precision={1} step={0.5} addonAfter="%" disabled={disabled || !value.bubble_enabled}
            value={value.bubble_shrink_percent} onChange={v => onChange({ ...value, bubble_shrink_percent: v ?? 0 })} />
        </Form.Item>
      </Form>
  )
}
