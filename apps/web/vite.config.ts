import react from '@vitejs/plugin-react';
import { loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from 'vitest/config';

import { normalizeBasePath } from "./src/app/base-path.js";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  const basePath = normalizeBasePath(process.env.VITE_BASE_PATH ?? environment.VITE_BASE_PATH);

  return {
    base: basePath,
    build: {
      outDir: process.env.E2E_BUILD_OUT_DIR ?? "dist",
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        strategies: "generateSW",
        includeManifestIcons: false,
        manifest: {
          name: "会议本",
          short_name: "会议本",
          lang: "zh-CN",
          description: "个人会议目录与离线同步",
          display: "standalone",
          start_url: basePath,
          scope: basePath,
          orientation: "any",
          theme_color: "#f7f7f5",
          background_color: "#f7f7f5",
          icons: [
            { src: `${basePath}icons/icon-192.png`, sizes: "192x192", type: "image/png" },
            { src: `${basePath}icons/icon-512.png`, sizes: "512x512", type: "image/png" },
            { src: `${basePath}icons/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
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
  };
});
