import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { createRequire } from "module";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

function copyRuntimeAssets(mode: string): Plugin {
  return {
    name: "copy-runtime-assets",
    writeBundle() {
      const distDir = resolve(__dirname, "dist");
      const envSource = mode === "dev"
        ? resolve(__dirname, ".env")
        : resolve(__dirname, ".env.example");
      const envTarget = resolve(distDir, ".env");

      if (existsSync(envSource)) {
        copyFileSync(envSource, envTarget);
      }

      const require = createRequire(import.meta.url);
      const swcPackagePath = require.resolve("@swc/wasm/package.json");
      const swcDir = dirname(swcPackagePath);
      const targetDir = resolve(distDir, "lib", "@swc", "wasm");

      mkdirSync(targetDir, { recursive: true });
      for (const file of ["wasm.js", "wasm_bg.wasm", "package.json"]) {
        copyFileSync(resolve(swcDir, file), resolve(targetDir, file));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const normalizedMode = mode || "test";
  const isProd = normalizedMode === "prod";
  const isTest = normalizedMode === "test";

  return {
    plugins: [copyRuntimeAssets(normalizedMode)],

    build: {
      ssr: true,
      outDir: "dist",
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "src/agent/index.ts"),
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
      noExternal: /^(?!vite|@swc\/wasm)/,
    },

    test: {
      globals: true,
      environment: "node",
      include: ["test/**/*.test.ts"],
      exclude: ["node_modules", "dist"],
      testTimeout: 10000,
      hookTimeout: 10000,
      reporters: ["verbose"],
    },

    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        "@test": resolve(__dirname, "./test"),
      },
    },
  };
});
