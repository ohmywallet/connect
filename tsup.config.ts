import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/wagmi.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false, // HMR 안정성: chunk 생성 비활성화
  treeshake: true,
  minify: false,
  sourcemap: false,
  external: ["viem", "@wagmi/core"],
  esbuildOptions(options) {
    // Remove esbuild's source-file banner comments without renaming public symbols.
    options.minifyWhitespace = true;
  },
});
