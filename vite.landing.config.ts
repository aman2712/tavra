import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/",
  publicDir: false,
  build: {
    outDir: "../landing-dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: resolve(process.cwd(), "web/index.html"),
    },
  },
});
