import { useState } from 'react'
import { Alert, Button, List, Modal, Typography } from 'antd'
import type { Project } from './workbench-api'

export function RepairScopeImportReport({ report }: { report: Project['repair_scope_import'] }) {
  const [visible, setVisible] = useState(true)
  const [open, setOpen] = useState(false)
  if (!report || (!report.skipped_images.length && !report.ignored_entries.length)) return null
  return <>
    {visible && <Alert type="warning" showIcon closable onClose={() => setVisible(false)}
      message={`裁切 JSON 匯入：${report.skipped_images.length} 張圖片未匯入，${report.ignored_entries.length} 筆未知檔名設定已略過。`}
      action={<Button size="small" onClick={() => setOpen(true)}>查看略過明細</Button>} />}
    <Modal title="裁切 JSON 匯入明細" open={open} onCancel={() => setOpen(false)} footer={null}>
      {report.skipped_images.length > 0 && <>
        <Typography.Title level={5}>未匯入的圖片（{report.skipped_images.length}）</Typography.Title>
        <List size="small" dataSource={report.skipped_images} renderItem={item => <List.Item><div style={{ overflowWrap: 'anywhere' }}><Typography.Text strong>{item.filename}</Typography.Text><div>{item.reason}</div></div></List.Item>} />
      </>}
      {report.ignored_entries.length > 0 && <>
        <Typography.Title level={5}>未知檔名設定（{report.ignored_entries.length}）</Typography.Title>
        <List size="small" dataSource={report.ignored_entries} renderItem={item => <List.Item><div style={{ overflowWrap: 'anywhere' }}><Typography.Text strong>{item.filename}</Typography.Text><div>{item.reason}</div></div></List.Item>} />
      </>}
    </Modal>
  </>
}
