import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["codex-remote.svg", "codex-remote-192.png", "codex-remote-512.png"],
      manifest: {
        id: "/",
        name: "OpenCodex Link",
        short_name: "Codex Link",
        description: "在手机上继续使用电脑里的 Codex",
        lang: "zh-CN",
        theme_color: "#101316",
        background_color: "#101316",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/codex-remote-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/codex-remote-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/codex-remote-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "/codex-remote.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true
      }
    }
  }
});
