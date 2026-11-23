/**
 * 主线程 ↔ Worker 的消息契约。两端共用，改一处即两端同步。
 */

// ---------- 导出 ----------

export interface ExportRequest {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  uniforms: Float32Array;
  curve: Float32Array;
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
  eyes: Uint8Array | null;
  eyeWidth: number;
  eyeHeight: number;
  lut: Uint8Array | null;
  quality: number;
}

export interface ExportResult {
  ok: boolean;
  blob?: Blob;
  width?: number;
  height?: number;
  downscaled?: boolean;
  error?: string;
}

// ---------- 分析 ----------

/** 人脸多边形（归一化坐标） */
export interface FacePolygons {
  oval: [number, number][];
  eyeL: [number, number][];
  eyeR: [number, number][];
}

/**
 * mask 用**裸 RGBA8 字节**传输，而不是 ImageBitmap。
 * 原因：ImageBitmap / canvas 默认按预乘 alpha 处理，
 * 而我们把"绿植"放在 A 通道，会被预乘直接抹成 0。
 */
export interface MaskPayload {
  width: number;
  height: number;
  quality: 'model' | 'heuristic';
  regions: { sky: number; person: number; skin: number; green: number };
  skinHue: number;
  skinSat: number;
  faceCount: number;
  pixels: Uint8ClampedArray;
  eyes: Uint8ClampedArray;
}

export interface AnalyzeMask {
  data: Uint8Array;
  width: number;
  height: number;
  eyeData: Uint8Array;
  quality: 'model' | 'heuristic';
  regions: { sky: number; person: number; skin: number; green: number };
  skinHue: number;
  skinSat: number;
  faceCount: number;
  ms: number;
}

export interface AnalyzeRequest {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  faces: FacePolygons[];
}

export interface AnalyzeInit {
  t: 'init';
  wasmBase: string;
  modelUrl: string;
}

export interface AnalyzeResult {
  ok: boolean;
  mask?: AnalyzeMask;
  error?: string;
}

// ---------- 守门 ----------

export interface GuardMetrics {
  contrast: number;
  hi: number;
  lo: number;
  sigma: number;
}

export type GuardRequest =
  | {
      t: 'source';
      bitmap: ImageBitmap;
      width: number;
      height: number;
      mask: Uint8Array | null;
      maskWidth: number;
      maskHeight: number;
      eyes: Uint8Array | null;
      lut: Uint8Array | null;
    }
  | {
      t: 'assets';
      mask: Uint8Array | null;
      maskWidth: number;
      maskHeight: number;
      eyes: Uint8Array | null;
      lut: Uint8Array | null;
    }
  | {
      t: 'check';
      id: number;
      uniforms: Float32Array;
      curve: Float32Array;
      size: number;
    };

export interface GuardSourceResult {
  t: 'source';
  ok: boolean;
  baseline?: GuardMetrics;
  error?: string;
}

export interface GuardCheckResult {
  t: 'check';
  id: number;
  metrics?: GuardMetrics;
  error?: string;
}