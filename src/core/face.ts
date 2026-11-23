/**
 * FaceMesh（MediaPipe FaceLandmarker）—— 主线程、按图调用一次。
 *
 * 为什么不在 Worker 里：tasks-vision 内部会创建 canvas 做图像预处理，
 * 在 Worker 里 `document` 不存在，路径不可靠。它单次推理只有几十毫秒，
 * 放在主线程做一次、而不是每帧做，是可以接受的取舍。
 *
 * 产出只有三样东西：脸廓多边形、左右眼多边形、人脸数量。
 * 后续的栅格化与模糊都在分析 Worker 里做（那边已经有处理 mask 的上下文）。
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

/** MediaPipe FaceMesh 468 点的固定索引 */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_R = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

export type Point = readonly [number, number];

export interface FaceShape {
  oval: Point[];
  eyeL: Point[];
  eyeR: Point[];
  /** 归一化包围盒 [x0, y0, x1, y1] */
  box: readonly [number, number, number, number];
}

let landmarkerPromise: Promise<FaceLandmarker | null> | null = null;
let landmarkerFailed = false;

export interface FaceOptions {
  /** 含 vision_wasm_internal.wasm 的目录绝对 URL */
  wasmDir: string;
  modelUrl: string;
}

async function getLandmarker(options: FaceOptions): Promise<FaceLandmarker | null> {
  if (landmarkerFailed) return null;
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(options.wasmDir);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: options.modelUrl, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 2,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    })();
  }
  try {
    return await landmarkerPromise;
  } catch (err) {
    landmarkerFailed = true;
    landmarkerPromise = null;
    console.warn('[face] FaceLandmarker 初始化失败:', err);
    return null;
  }
}

function pickRaw(points: { x: number; y: number }[], indices: number[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const i of indices) {
    const p = points[i];
    if (p) out.push(p);
  }
  return out;
}

/**
 * MediaPipe 的检测器会把整张图缩到一个很小的方形输入里，
 * 全身照里的人脸（占画面 <15%）经常直接漏检。
 * 所以先整图跑一次，没找到再按"中心偏上"的裁剪重试两次。
 * 裁剪坐标会映射回原图，调用方拿到的永远是原图归一化坐标。
 */
const PASSES: { rect: readonly [number, number, number, number]; target: number }[] = [
  { rect: [0, 0, 1, 1], target: 768 },
  { rect: [0.18, 0.05, 0.64, 0.64], target: 768 },
  { rect: [0.3, 0.12, 0.4, 0.4], target: 640 },
];

function toShapes(
  landmarks: { x: number; y: number }[][],
  rect: readonly [number, number, number, number],
): FaceShape[] {
  const [rx, ry, rw, rh] = rect;
  const map = (p: { x: number; y: number }): [number, number] => [rx + p.x * rw, ry + p.y * rh];

  return landmarks.map((points) => {
    const oval: Point[] = pickRaw(points, FACE_OVAL).map(map);
    const eyeL: Point[] = pickRaw(points, EYE_L).map(map);
    const eyeR: Point[] = pickRaw(points, EYE_R).map(map);
    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;
    for (const [x, y] of oval) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { oval, eyeL, eyeR, box: [x0, y0, x1, y1] as const };
  });
}

/**
 * 检测人脸。失败返回空数组（调用方照常降级，不影响修图主流程）。
 */
export async function detectFaces(bitmap: ImageBitmap, options: FaceOptions): Promise<FaceShape[]> {
  const landmarker = await getLandmarker(options);
  if (!landmarker) return [];

  try {
    for (const pass of PASSES) {
      const [rx, ry, rw, rh] = pass.rect;
      const sx = Math.round(rx * bitmap.width);
      const sy = Math.round(ry * bitmap.height);
      const sw = Math.max(16, Math.round(rw * bitmap.width));
      const sh = Math.max(16, Math.round(rh * bitmap.height));
      const scale = Math.min(1, pass.target / Math.max(sw, sh));

      const input =
        pass.rect[2] === 1
          ? bitmap
          : await createImageBitmap(bitmap, sx, sy, sw, sh, {
              resizeWidth: Math.round(sw * scale),
              resizeHeight: Math.round(sh * scale),
              resizeQuality: 'high',
            });

      const result = landmarker.detect(input);
      if (input !== bitmap) input.close();

      if (result.faceLandmarks?.length) {
        return toShapes(result.faceLandmarks, pass.rect);
      }
    }
    return [];
  } catch (err) {
    console.warn('[face] 检测失败:', err);
    return [];
  }
}

/** 预热：首帧之后空闲时调用，避免第一次载图时多等 300ms */
export function preloadFace(options: FaceOptions): void {
  void getLandmarker(options);
}