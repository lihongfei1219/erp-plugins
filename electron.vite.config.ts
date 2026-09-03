import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // Internal distributions bundle DASHSCOPE_API_KEY into the main process.
    // The renderer and preload builds keep their default, separate prefixes.
    envPrefix: ['MAIN_VITE_', 'DASHSCOPE_'],
    build: {
      // Electron Vite externalizes dependencies as CommonJS by default. These
      // packages are ESM-only, so leaving them external would generate
      // require(...) calls that Electron cannot resolve at runtime.
      externalizeDeps: {
        exclude: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'pdfjs-dist']
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [vue()]
  }
})
