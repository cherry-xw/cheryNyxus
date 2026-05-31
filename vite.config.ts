import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // SSR 打包配置
  build: {
    ssr: true,
    outDir: "dist",
    lib: {
      entry: resolve(__dirname, "src/agent/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["dotenv", "ollama", "openai"],
    },
    sourcemap: true,
    minify: false,
  },

  // Vitest 配置
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 10000,
    hookTimeout: 10000,
    reporters: ["verbose"],
  },

  // 路径别名
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@test": resolve(__dirname, "./test"),
    },
  },
});