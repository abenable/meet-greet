import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devWebSocketPlugin } from './dev-ws-plugin'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    devWebSocketPlugin(),
    // VitePWA has been removed rather than reconfigured.
    //
    // Its generateSW output was never used: public/sw.js is copied into
    // dist/client and overwrote the generated worker, so the precache manifest
    // and all four runtimeCaching rules configured here were dead code. Its
    // injectManifest mode emits nothing under TanStack Start's
    // multi-environment build, so there was no working migration path either.
    //
    // public/sw.js is now the single service worker: push handling plus a
    // conservative same-origin asset cache. The manifest the app actually
    // links to is public/manifest.json.
  ],
})

export default config
