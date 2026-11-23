# Sfumato · 本地修图工具

*Sfumato* —— 达·芬奇的"晕涂法"：明暗之间只有柔和的过渡，没有硬边。
这也正是这个工具想做的事：不做硬蒙版，不留光晕。

打开任何一张 JPEG/PNG，它已经变干净了；想再多一点，就拉六根滑杆。
**不需要手动画蒙版**——区域由分析阶段自动给出。

纯前端、零后端、零网络请求（模型与运行时全部随包分发）。

---

## 现在能做什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 万金油（不可关） | ✅ | 白平衡 / 曝光 / 高光柔化 / 自适应曲线 / 局部对比 / 锐化 |
| 六滑杆（亮暖浓净软风格） | ✅ | 全部是相对量，作用在万金油之上 |
| 可选项（人像/天空/绿植/去灰/胶片/夜景） | ✅ | 默认值由规则表决定，用户改过即锁定 |
| 自动 mask（不抠图） | ✅ | MODNet int8 + 启发式天空/皮肤/绿植 |
| FaceMesh | ✅ | 脸廓收窄肤色权重 · 眼睛单独出通道做眼神光 · 多尺度检小脸 |
| 导出 JPEG | ✅ | q=0.93，Worker 内全尺寸重放，主线程不卡 |
| 预设（存/取/导入/导出） | ✅ | IndexedDB，只存"意图"不存参数快照 |
| 风格 LUT（.cube 导入/导出） | ✅ | 33³，四面体插值 |
| 从参考图学风格 | ✅ | 按亮度分箱迁移，带安全带 |
| 守门员（自动回退） | ✅ | 四项硬指标；在独立 Worker 里渲染+统计，主线程零阻塞 |
| 撤销 | ✅ | Ctrl+Z / 工具栏按钮，30 步；Ctrl+Shift+Z 重置 |
| 批量导出 | ✅ | 串行；可写目录或有同名覆盖确认；失败有清单；Esc 取消 |
| 视图缩放 | ✅ | 适应窗口 / 1:1 切换 |
| 快捷键 | ✅ | `\` 对比 · `Ctrl+Z` 重置 · `Ctrl+S` 导出 · `Ctrl+O` 打开 |

## 明确不做

- 不做后端 / 账号 / 分享 / 付费
- 不做生成式修改（不换天、不换脸、不去路人）
- 不做手动抠图（区域自动，只能调强度）
- 不支持 HEIC / RAW / WebP / AVIF；**导出只有 JPEG**

---

## 快速开始

```bash
cd photo-tool
NODE_ENV=development npm install --include=dev
NODE_ENV=development npm run build
python3 -m http.server 4173 --directory dist
# 打开 http://127.0.0.1:4173/
```

> `NODE_ENV=development` 必须带。环境里若设了 `NODE_ENV=production`，
> npm 会跳过 devDependencies，`tsc`/`vite` 不会被安装。

开发模式：

```bash
NODE_ENV=development npm run dev      # http://localhost:5173
NODE_ENV=development npm run build    # 类型检查 + 产出 dist/
```

打包成双击即用的桌面应用见 [docs/04-打包与离线.md](docs/04-打包与离线.md)。

---

## 架构（一图流）

```
Main Thread ── UI + WebGL2 预览（一次 draw call）
  │
  ├─ AnalyzeWorker（常驻）  1024px 副本 → MODNet → mask(RGBA8) + stats
  ├─ ExportWorker（按需）   全尺寸 → 同一份 GLSL → JPEG
  └─ 预览与导出共用 src/gl/shaders/pipeline.frag
```

- 四个 Worker：analyze（mask）/ export（出图）/ guard（守门）/ 主线程只做 UI 与预览
- 单 shader、单 draw call，mip level 4 直接当局部对比基准
- mask 是**裸 RGBA8 字节**（R 人像 / G 皮肤 / B 天空 / A 绿植），避开预乘 alpha
- 第二张 mask 只装眼睛（R 通道），FaceMesh 在主线程跑、Worker 只负责栅格化
- shader 里没有 `amount`，也没有 identity 分支：强度语义全在 `src/core/mapping.ts`

## 目录

```
src/
├─ core/      color stats curve mapping constants decode presets storage
│             export analyze guard  lut/{cube,transfer}
├─ gl/        context shader textures renderer  shaders/pipeline.{vert,frag}
├─ workers/   analyze.worker  export.worker
├─ ui/        sliders modules chips
├─ app/       Editor.ts
└─ main.ts
public/       models/{modnet_int8.onnx, face_landmarker.task}
              ort/ort-wasm-simd-threaded.{wasm,mjs}  vision/vision_wasm_internal.{js,wasm}
tests/        harness.py  test_p0..p5.py  assets/  out/
```

## 验收

```bash
python3 tests/test_p0.py   # 脚手架 / WebGL2 / 渲染循环
python3 tests/test_p1.py   # 恒等性 + 万金油行为
python3 tests/test_p2.py   # 导出 + 预设持久化
python3 tests/test_p3.py   # 分析 Worker + 区域增益
python3 tests/test_p4.py   # .cube + 参考图学习
python3 tests/test_p5.py   # 守门员 + 位图释放 + 快捷键
python3 tests/test_p6.py   # FaceMesh + 眼神光只作用在眼睛区域
```

测试用 Playwright + 系统 Chromium（SwiftShader 软渲染），无需 GPU。
截图输出在 `tests/out/`。

## 文档

| 文档 | 内容 |
|---|---|
| [01-总体方案](docs/01-总体方案.md) | 产品定义、决策与被否决方案、线程模型、风险 |
| [02-算子与参数规格](docs/02-算子与参数规格.md) | 算子数学、uniform 布局、mask/LUT 规格、规则表 |
| [03-开发阶段](docs/03-开发阶段.md) | P0–P5 任务、验收标准 |
| [04-打包与离线](docs/04-打包与离线.md) | 本机服务 / Tauri / COOP-COEP / 离线验收 |

> 02 号文档开头有「实现差异」一节，记录落地时对规格的修正——**以那一节为准**。

---

*版本 0.3 · 2026-11-22 · 内部代号 Grain（文档中沿用）*