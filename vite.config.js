import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: "app",
  plugins: [react()],
  resolve: {
    alias: {
      "@data": path.resolve(process.cwd(), "data"),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [process.cwd()],
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
