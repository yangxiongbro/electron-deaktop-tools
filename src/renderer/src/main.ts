import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/index.css'
import App from './App.vue'
import { initSettings } from './stores/settings'

async function bootstrap(): Promise<void> {
  // 先读取持久化设置（主题等），再挂载界面，避免暗色主题启动时闪白
  try {
    await initSettings()
  } catch (error) {
    console.error('[settings] 初始化失败，使用默认设置', error)
  }

  const app = createApp(App)
  app.use(ElementPlus, { locale: zhCn })
  app.mount('#app')
}

void bootstrap()
