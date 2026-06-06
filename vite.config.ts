import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { createRequire } from "module";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import nativeModules from "vite-plugin-native-modules";

function postBuildFix(): Plugin {
  return {
    name: "post-build-fix",
    enforce: "post",
    writeBundle() {
      const distDir = resolve(__dirname, "dist");
      const libDir = resolve(distDir, "lib");
      const distFile = resolve(distDir, "index.js");

      // ===== .env 复制 =====
      const envSource = resolve(__dirname, ".env");
      if (existsSync(envSource)) {
        copyFileSync(envSource, resolve(distDir, ".env"));
      }

      // ===== @swc/wasm 复制 =====
      const require = createRequire(import.meta.url);
      const swcDir = dirname(require.resolve("@swc/wasm/package.json"));
      const swcTargetDir = resolve(libDir, "@swc", "wasm");
      mkdirSync(swcTargetDir, { recursive: true });
      for (const file of ["wasm.js", "wasm_bg.wasm", "package.json"]) {
        copyFileSync(resolve(swcDir, file), resolve(swcTargetDir, file));
      }

      // ===== native addon 复制到 dist/lib/ =====
      const nodeFiles = readdirSync(distDir).filter((f) => f.endsWith(".node"));
      mkdirSync(libDir, { recursive: true });
      for (const f of nodeFiles) {
        copyFileSync(resolve(distDir, f), resolve(libDir, f));
        rmSync(resolve(distDir, f));
      }

      // ===== index.js 补丁 =====
      if (!existsSync(distFile)) return;
      let code = readFileSync(distFile, "utf-8");
      let patched = false;

      // 修正 native addon 加载路径：dist/ → dist/lib/
      for (const f of nodeFiles) {
        const oldPath = `"./${f}"`;
        const newPath = `"./lib/${f}"`;
        if (code.includes(oldPath)) {
          code = code.replace(oldPath, newPath);
          patched = true;
        }
      }

      // 修正 addon 导出结构：nativeModules 包装成 { default: addon }
      // 但 better-sqlite3 需要直接访问 addon.setErrorConstructor() 等方法
      const addonPattern = /addon = DEFAULT_ADDON \|\| \(DEFAULT_ADDON = \(init_better_sqlite3\(\), __toCommonJS\(better_sqlite3_exports\)\)\)/;
      if (addonPattern.test(code)) {
        code = code.replace(addonPattern, "addon = DEFAULT_ADDON || (DEFAULT_ADDON = (init_better_sqlite3(), nativeModule))");
        patched = true;
      }

      if (patched) {
        writeFileSync(distFile, code);
        console.log("✓ post-build patches applied");
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const normalizedMode = mode || "test";
  const isProd = normalizedMode === "prod";
  const isTest = normalizedMode === "test";  return {
    plugins: [
      nativeModules(),
      postBuildFix(),
    ],

    build: {
      ssr: true,
      outDir: "dist",
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "src/index.ts"),
        formats: ["es"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
      sourcemap: isTest,
      minify: isProd ? "esbuild" : false,
    },

    ssr: {
      noExternal: /^(?!vite|@swc\/wasm|better-sqlite3)/,
      external: ["better-sqlite3"],
    },

    test: {
      globals: true,
      environment: "node",
      include: ["test/**/*.test.ts"],
      exclude: ["node_modules", "dist"],
      testTimeout: 10000,
      hookTimeout: 10000,
      reporters: ["verbose"],
      coverage: {
        provider: "v8",
        reporter: ["text", "text-summary", "html"],
        // 忽略纯导出文件（只做 re-export，无业务逻辑）
        exclude: [
          // 排除测试文件本身
          "test/**",
          // 排除类型定义文件
          "**/*.d.ts",
          // 排除编译产物
          "dist/**",
          // 排除工具测试 fixtures
          "src/utils/tools/**",
          "src/utils/custom/**",
          // 真正的纯导出文件（只有 export 语句）
          "src/core/llm/index.ts",
          "src/core/message/index.ts",
          "src/core/sense/compiler/index.ts",
          "src/core/sense/index.ts",
          "src/service/message/index.ts",
          "src/utils/logger/bashLogger.ts",
        ],
        // 包含所有 src 文件
        include: ["src/**"],
      },
    },

    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        "@test": resolve(__dirname, "./test"),
      },
    },
  };
});
