import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  outExtension() {
    return { js: ".js" };
  },
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/./],
});
