import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["codex-remote.svg"],
      manifest: {
        name: "Codex Remote",
        short_name: "Codex",
        description: "在手机上继续使用电脑里的 Codex",
        theme_color: "#101316",
        background_color: "#101316",
        display: "standalone",
        start_url: "/",
        icons: [
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

