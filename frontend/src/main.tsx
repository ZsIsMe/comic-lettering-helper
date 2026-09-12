import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhTW from 'antd/locale/zh_TW'
import App from './WorkspaceRouter'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhTW}
      theme={{
        token: {
          colorPrimary: '#da4f2a',
          colorInfo: '#2d6671',
          colorSuccess: '#28714b',
          colorText: '#25231f',
          colorBgBase: '#f5f1e8',
          borderRadius: 10,
          fontFamily: '"PingFang TC", "Microsoft JhengHei", sans-serif',
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
)
