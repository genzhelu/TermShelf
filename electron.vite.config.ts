import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * The strict production CSP blocks Vite's inline React-refresh preamble and
 * websocket HMR client. Relax only the dev-server document; packaged builds
 * keep script-src 'self'.
 */
function devCspPlugin(): Plugin {
  return {
    name: 'termshelf-dev-csp',
    transformIndexHtml(html, ctx) {
      if (!ctx.server) return html
      return html
        .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace(
          "connect-src 'self' ws: wss:;",
          "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*;"
        )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), devCspPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
