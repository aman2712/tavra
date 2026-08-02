import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/checkout-assets/",
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
