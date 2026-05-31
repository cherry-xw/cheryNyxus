import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  // 默认构建（无 mode）视为测试环境
  const isProd = mode === "prod";
  const isTest = mode === "test" || !mode; // 默认或测试环境都生成 source map

  return {
    // SSR 打包配置
    build: {
      ssr: true,
      outDir: "dist",
      rollupOptions: {
        input: resolve(__dirname, "src/agent/index.ts"),
        output: {
          format: "es",
          entryFileNames: "index.js",
          codeSplitting: false, // 单文件打包（放在 output 中）
        },
      },
      sourcemap: isTest, // 测试环境生成 source map
      minify: isProd ? "esbuild" : false, // 生产环境压缩混淆
    },

    // SSR 配置：打包所有依赖，但外部化 Vite（避免路径解析错误）
    ssr: {
      noExternal: /^(?!vite)/, // 排除 vite 相关包
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
  };
});