import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  resolve: {
    // 让 onnxruntime-web 使用"外部 wasm"构建：JS 很小，wasm 从 /ort/ 运行时加载。
    // 否则默认入口会把 15MB 的 wasm 内联进 JS 包。
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});