import react from '@vitejs/plugin-react';
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "generateSW",
      includeManifestIcons: false,
      manifest: {
        name: "会议本",
        short_name: "会议本",
        description: "个人会议录音、手写与 AI 纪要",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "any",
        theme_color: "#f7f7f5",
        background_color: "#f7f7f5",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png}"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    }
  }
});
