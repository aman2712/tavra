import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "web",
  base: "/checkout-assets/",
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        landing: resolve(process.cwd(), "web/index.html"),
        checkout: resolve(process.cwd(), "web/checkout.html"),
      },
    },
  },
});
