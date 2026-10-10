import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/calyze/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      scope: "/calyze/",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Calyze",
        short_name: "Calyze",
        start_url: "/calyze/",
        scope: "/calyze/",
        description: "Historical trading analysis, chart replay and leveraged account simulator",
        theme_color: "#0b0e11",
        background_color: "#0b0e11",
        display: "standalone",
        orientation: "any",
        icons: [
          {
            src: "/calyze/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any"
          }
        ]
      }
    })
  ]
});
