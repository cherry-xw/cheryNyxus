import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isProd = mode === "prod";
  const isTest = mode === "test" || !mode;

  return {
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
      noExternal: /^(?!vite)/,
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
