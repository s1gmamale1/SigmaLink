import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// P3-S8 — manualChunks vendor split. Cuts the main initial chunk by routing
// stable vendor groups into long-lived files. Monaco is already lazy-loaded
// via dynamic import in EditorTab, so it stays out of this map. The
// catch-all `node_modules` group below ensures any unmatched dep ends up in
// `vendor` rather than the app chunk.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Keep Monaco isolated and lazy: never route it into a vendor
            // bucket — let Vite's dynamic-import code-splitting own it.
            if (id.includes('monaco')) return undefined;
            if (id.includes('@radix-ui')) return 'vendor-radix';
            if (id.includes('@dnd-kit')) return 'vendor-dnd';
            if (id.includes('sonner') || id.includes('cmdk')) return 'vendor-cmdk';
            if (id.includes('@xterm')) return 'vendor-xterm';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          }
        },
      },
    },
  },
});
