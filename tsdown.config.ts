export default {
  workspace: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/test?(s)/**", "**/t?(e)mp/**", "**/docsweb/**"],
  },
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  target: "es2023",
  fixedExtension: false,
  dts: true,
  clean: false,
  deps: { neverBundle: ["vite"] },
};
