import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const isCapacitorBuild = process.env.CAPACITOR_BUILD === '1' || process.env.CAPACITOR_BUILD === 'true'

export default defineConfig({
  base: './',
  envDir: '../..',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(!isCapacitorBuild
      ? [
          VitePWA({
            registerType: 'prompt',
            includeAssets: [],
            includeManifestIcons: false,
            manifest: {
              name: 'All in One',
              short_name: 'All in One',
              description: 'All in One — 跨设备 AI 编程助手远程总控（ChatGPT / Claude Code / Antigravity / DeepSeek Harness / WorkBuddy / ZCode）',
              theme_color: '#03080E',
              background_color: '#03080E',
              display: 'standalone',
              orientation: 'portrait',
              start_url: './',
              icons: [
                {
                  src: 'icon-192.png',
                  sizes: '192x192',
                  type: 'image/png',
                  purpose: 'any maskable',
                },
                {
                  src: 'icon-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'any maskable',
                },
              ],
            },
            workbox: {
              skipWaiting: false,
              clientsClaim: false,
              cleanupOutdatedCaches: true,
              globPatterns: ['**/*.{js,css,svg,png,woff2}'],
              globIgnores: [
                'downloads/**',
                'assets/jsQR-*.js',
                'assets/hljs-lang-*.js',
                'assets/*Modal-*.js',
                'assets/ModelPickerSheet-*.js',
                'assets/ImageLightbox-*.js',
                'assets/LoginScreen-*.js',
              ],
              navigateFallback: null,
              runtimeCaching: [
                {
                  urlPattern: ({ request, url }) =>
                    request.mode === 'navigate' &&
                    !/\/admin(?:\/|$)/i.test(url.pathname) &&
                    !/\/api(?:\/|$)/i.test(url.pathname),
                  handler: 'NetworkFirst',
                  options: {
                    cacheName: 'pages-cache',
                    networkTimeoutSeconds: 4,
                    expiration: {
                      maxEntries: 32,
                      maxAgeSeconds: 86400,
                    },
                  },
                },
                {
                  urlPattern: ({ request, url }) =>
                    request.destination === 'script' && /\/assets\/[^/]+\.js$/i.test(url.pathname),
                  handler: 'CacheFirst',
                  options: {
                    cacheName: 'lazy-js-chunks',
                    expiration: {
                      maxEntries: 80,
                      maxAgeSeconds: 30 * 24 * 60 * 60,
                    },
                  },
                },
              ],
            },
          }),
        ]
      : []),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          const norm = id.replace(/\\/g, '/')
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(norm)) {
            return 'react-vendor'
          }
          if (
            /\/node_modules\/(react-markdown|remark-gfm|remark-[^/]+|rehype-[^/]+|micromark[^/]*|mdast[^/]*|hast[^/]*|unified|unist[^/]*|vfile[^/]*|property-information|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities[^/]*|html-url-attributes|devlop|bail|is-plain-obj|trough|trim-lines|ccount|escape-string-regexp|markdown-table|longest-streak|zwitch)\//.test(
              norm,
            )
          ) {
            return 'markdown-vendor'
          }
          if (/\/node_modules\/highlight\.js\/(?:lib|es)\/core\.js$/.test(norm)) {
            return 'hljs-core'
          }
          const hljsLang = norm.match(/\/node_modules\/highlight\.js\/(?:lib|es)\/languages\/([^/]+?)(?:\.js)?$/)
          if (hljsLang) {
            return `hljs-lang-${hljsLang[1]}`
          }
          if (/\/node_modules\/jsqr\//.test(norm)) {
            return 'jsQR'
          }
          if (/\/node_modules\/lucide-react\//.test(norm)) {
            return 'lucide'
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
})
