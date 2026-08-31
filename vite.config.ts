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

      // dist is intentionally retained between builds for native artifacts;
      // remove a stale legacy copy so old builds cannot keep shipping secrets.
      rmSync(resolve(distDir, ".env"), { force: true });

      // ===== @swc/wasm 复制 =====
      const require = createRequire(import.meta.url);
      const swcDir = dirname(require.resolve("@swc/wasm/package.json"));
      const swcTargetDir = resolve(libDir, "@swc", "wasm");
      mkdirSync(swcTargetDir, { recursive: true });
      for (const file of ["wasm.js", "wasm_bg.wasm", "package.json"]) {
        copyFileSync(resolve(swcDir, file), resolve(swcTargetDir, file));
      }

      // ===== native addon 复制到 dist/lib/（带 EBUSY 重试，应对 Windows 文件锁定）=====
      // 复制失败只 warn 不中断：addon 导出补丁（下方 index.js 补丁）必须执行，
      // 否则 addon 指向 exports 壳对象，运行期 addon.setErrorConstructor is not a function 崩溃。
      const nodeFiles = readdirSync(distDir).filter((f) => f.endsWith(".node"));
      const moved: string[] = [];
      if (nodeFiles.length > 0) {
        mkdirSync(libDir, { recursive: true });
        for (const f of nodeFiles) {
          const src = resolve(distDir, f);
          const dst = resolve(libDir, f);
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            try {
              copyFileSync(src, dst);
              rmSync(src);
              ok = true;
            } catch (err: any) {
              if (err?.code === "EBUSY" && attempt < 2) {
                // Windows 文件锁定，同步等待后重试
                const end = Date.now() + 500;
                while (Date.now() < end) { /* busy-wait */ }
              } else {
                console.warn(`[post-build-fix] 移动 ${f} 到 lib/ 失败（保留 dist 根副本）:`, err?.message ?? err);
                break; // 不再重试；该文件不参与路径补丁
              }
            }
          }
          if (ok) moved.push(f);
        }
      }

      // ===== web 整目录复制（ESM 模块化前端，多文件）=====
      // 已移除：web 模块迁移至独立工作区 web/，不再随 SSR 打包复制。

      // ===== index.js 补丁 =====
      if (!existsSync(distFile)) return;
      let code = readFileSync(distFile, "utf-8");
      let patched = false;

      // 修正 native addon 加载路径：dist/ → dist/lib/（仅对成功移动的 .node；
      // 复制失败的文件仍留在 dist 根，保持原路径才能加载）。
      for (const f of moved) {
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
      } else {
        // 兜底：bundle 结构变化时精确正则可能失效，剥壳取 nativeModule 亦可
        const fallback = /DEFAULT_ADDON = \(init_better_sqlite3\(\), __toCommonJS\(better_sqlite3_exports\)\)/;
        if (fallback.test(code)) {
          code = code.replace(fallback, "DEFAULT_ADDON = (init_better_sqlite3(), better_sqlite3_exports.default)");
          patched = true;
        }
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
      noExternal: true, // 打包所有依赖，包括 native 模块的 JS 部分
      // fff（@ff-labs/fff-node，ffi-rs 加载的原生 .so）必须外置：其 findBinary() 用
      // import.meta.url + createRequire 解析平台包 @ff-labs/fff-bin-*，打包后 import.meta.url
      // 指向 dist/，且 pnpm 未把 @ff-labs/fff-bin-* 提升到项目根 → 打包会找不到 .so。
      // ssr.external 先于 noExternal 判定（Vite createIsConfiguredAsExternal），运行时从
      // node_modules 原样加载 fff，绕过打包副作用。仅 search_codebase 感官依赖。
      external: ["@ff-labs/fff-node", "ffi-rs"],
    },

    test: {
      globals: true,
      environment: "node",
      include: ["test/**/*.test.ts"],
      exclude: ["test/protocol-completeness/**", "node_modules", "dist"],
      globalSetup: ["test/globalSetup.ts"],
      // 普通后端测试使用每文件独立的 fixtures 副本，避免并行进程争用 DB/Mock 文件。
      // 必须在测试文件 import config 链之前执行（setup.ts 不 import config）
      setupFiles: ["test/flows/setup.ts"],
      testTimeout: 15000,
      hookTimeout: 15000,
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
        "@chery/protocol": resolve(__dirname, "./packages/protocol/src"),
        "@test": resolve(__dirname, "./test"),
      },
    },
  };
});
