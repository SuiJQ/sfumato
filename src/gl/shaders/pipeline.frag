#version 300 es
// 单次 draw 的完整调色管线。
// 约定：这里没有 amount、没有 identity 判断——所有强度语义在 JS 映射层完成。

precision highp float;
precision highp sampler3D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;    // 原图（RGBA8，带 mipmap）
uniform sampler2D u_mask;   // R=人像 G=皮肤 B=天空 A=绿植
uniform sampler2D u_mask2;  // R = 眼睛
uniform sampler2D u_curve;  // 256×1，A 通道为亮度曲线
uniform sampler3D u_lut;    // 33³ 风格 LUT

uniform vec4 u_p[8];
uniform vec2 u_res;         // 目标分辨率（像素）
uniform vec2 u_maskSize;    // mask 分辨率
uniform float u_hasMask;    // 0 / 1
uniform float u_hasEye;     // 0 / 1
uniform float u_lodBase;    // 显示采样所处的 mip 级（原图比画布大多少）
uniform float u_hasLut;     // 0 / 1

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float LUT_SIZE = 33.0;

// ---------- 基础 ----------

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

float luma(vec3 c) { return dot(c, LUMA); }

vec2 rotate2(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// 曲线采样：把 L∈[0,1] 精确映射到 256 个纹素中心，避免暗部被夹死
float curveAt(float x) {
  float u = (clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  return texture(u_curve, vec2(u, 0.5)).a;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// GLSL ES 没有 cbrt：用 sign 安全的 pow 代替
vec3 cbrt3(vec3 x) {
  return sign(x) * pow(abs(x), vec3(1.0 / 3.0));
}

vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  vec3 x = cbrt3(vec3(l, m, s));
  return vec3(
    0.2104542553 * x.x + 0.7936177850 * x.y - 0.0040720468 * x.z,
    1.9779984951 * x.x - 2.4285922050 * x.y + 0.4505937099 * x.z,
    0.0259040371 * x.x + 0.7827717662 * x.y - 0.8086757660 * x.z
  );
}

vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 x = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3(
     4.0767416621 * x.x - 3.3077115913 * x.y + 0.2309699292 * x.z,
    -1.2684380046 * x.x + 2.6097574011 * x.y - 0.3413193965 * x.z,
    -0.0041960863 * x.x - 0.7034186147 * x.y + 1.7076147010 * x.z
  );
}

// ---------- mask：4 抽头联合双边上采样 ----------
// 以原图亮度为引导，避免低分辨率 mask 上采样后出现光晕。

vec4 sampleMask(vec2 uv) {
  if (u_hasMask < 0.5) return vec4(0.0);
  vec2 t = 1.0 / max(u_maskSize, vec2(1.0));
  float g0 = luma(textureLod(u_tex, uv, 2.0).rgb);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2((i == 1 || i == 3) ? 0.5 : -0.5, (i >= 2) ? 0.5 : -0.5) * t;
    vec2 u2 = uv + o;
    float g = luma(textureLod(u_tex, u2, 2.0).rgb);
    float d = g - g0;
    float w = exp(-(d * d) / 0.02);
    acc += texture(u_mask, u2) * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}

// ---------- 3D LUT：四面体插值（三线性会在天空出色带） ----------

vec3 lutTetrahedral(vec3 c) {
  vec3 p = clamp(c, 0.0, 1.0) * (LUT_SIZE - 1.0);
  ivec3 i0 = ivec3(floor(p));
  vec3 f = p - vec3(i0);
  ivec3 i1 = min(i0 + 1, ivec3(int(LUT_SIZE) - 1));

  // texelFetch 精确取格点，避免纹理过滤在格点之间插值带来的偏差
  vec3 c000 = texelFetch(u_lut, ivec3(i0.x, i0.y, i0.z), 0).rgb;
  vec3 c111 = texelFetch(u_lut, ivec3(i1.x, i1.y, i1.z), 0).rgb;
  vec3 c100 = texelFetch(u_lut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
  vec3 c010 = texelFetch(u_lut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
  vec3 c001 = texelFetch(u_lut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
  vec3 c110 = texelFetch(u_lut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
  vec3 c101 = texelFetch(u_lut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
  vec3 c011 = texelFetch(u_lut, ivec3(i0.x, i1.y, i1.z), 0).rgb;

  vec3 res;
  if (f.x > f.y) {
    if (f.y > f.z) {
      res = c000 + f.x * (c100 - c000) + f.y * (c110 - c100) + f.z * (c111 - c110);
    } else if (f.x > f.z) {
      res = c000 + f.x * (c100 - c000) + f.z * (c101 - c100) + f.y * (c111 - c101);
    } else {
      res = c000 + f.z * (c001 - c000) + f.x * (c101 - c001) + f.y * (c111 - c101);
    }
  } else {
    if (f.z > f.y) {
      res = c000 + f.z * (c001 - c000) + f.y * (c011 - c001) + f.x * (c111 - c011);
    } else if (f.z > f.x) {
      res = c000 + f.y * (c010 - c000) + f.z * (c011 - c010) + f.x * (c111 - c011);
    } else {
      res = c000 + f.y * (c010 - c000) + f.x * (c110 - c010) + f.z * (c111 - c110);
    }
  }
  return res;
}

void main() {
  vec4 p0 = u_p[0];
  vec2 uv = v_uv;

  // 0. 直通 alpha 合成到白底（导出 JPEG 必须有确定背景）
  vec4 src = texture(u_tex, uv);
  vec3 c = src.rgb * src.a + (1.0 - src.a);

  // 1. 白平衡 + 曝光（线性光）
  vec3 lin = srgbToLinear(c);
  lin *= vec3(1.0 + 0.30 * p0.y + 0.05 * p0.z,
              1.0 - 0.10 * p0.z,
              1.0 - 0.30 * p0.y + 0.05 * p0.z);
  lin *= exp2(p0.x);

  // 2. 转到显示域做色调（曲线是为人眼设计的，在编码域采样更合理）
  vec3 e = linearToSrgb(lin);

  // 3. 高光柔化：软压缩而非硬截断
  float knee = clamp(u_p[1].x, 0.3, 1.0);
  if (knee < 0.999) {
    float soft = knee + (1.0 - knee) * (1.0 - exp(-(e.r - knee) / (1.0 - knee)));
    e.r = e.r > knee ? soft : e.r;
    soft = knee + (1.0 - knee) * (1.0 - exp(-(e.g - knee) / (1.0 - knee)));
    e.g = e.g > knee ? soft : e.g;
    soft = knee + (1.0 - knee) * (1.0 - exp(-(e.b - knee) / (1.0 - knee)));
    e.b = e.b > knee ? soft : e.b;
  }

  // 4. 亮度曲线 + 阴影抬升（只动亮度，等比缩放 RGB → 保色相）
  float L = luma(e);
  float Lc = curveAt(L);
  float Ll = Lc + u_p[1].y * (1.0 - Lc) * (1.0 - Lc);
  e *= Ll / max(L, 1e-4);

  // 5. 区域权重提前取：皮肤要少加纹理，眼睛要多加
  vec4 m = sampleMask(uv);
  // 三个通道是各自独立模糊后写入的，不保证和为 1（暖色天空可能 skin≈0.9 且 sky≈1.0）。
  // 不归一的话 satMul 会比设计值高 30–60%，色度冲出 gamut 后被硬夹，表现为偏色/色带。
  float wSky = m.b;
  float wSkin = m.g;
  float wGreen = m.a;
  float wSum = wSky + wSkin + wGreen;
  float wNorm = 1.0 / max(1.0, wSum);
  wSky *= wNorm;
  wSkin *= wNorm;
  wGreen *= wNorm;
  float wRest = max(0.0, 1.0 - wSky - wSkin - wGreen);

  // 5a. 眼神光：只有 FaceMesh 给出眼睛区域时才生效
  float wEye = u_hasEye > 0.5 ? texture(u_mask2, uv).r : 0.0;
  e *= 1.0 + u_p[7].w * wEye;

  // 5b. 局部对比 + 锐化（在原图的编码域取细节，量级由参数吸收）
  //     人脸在 1:1 下对锐化极敏感：毛孔、胡渣、皮肤纹理都会被放大成"砂纸"，
  //     所以在皮肤区域主动收掉一半，背景该锐还是锐。
  float skinGuard = 1.0 - 0.55 * wSkin;
  float Lraw = luma(c);
  // 高光区只压 55%，完全清零会把云、雪、叶隙的纹理抹平（实测纹理能量 -48%）
  float guard = smoothstep(0.02, 0.15, Ll) * (1.0 - 0.55 * smoothstep(0.85, 1.0, Ll));
  float blurL = luma(textureLod(u_tex, uv, u_p[1].w).rgb);
  e += (Lraw - blurL) * u_p[1].z * guard * skinGuard;

  // 与 c 的隐式 LOD 对齐：否则大图缩到画布时 Lraw 比 smL 更糊，
  // 差值符号翻转，锐化会变成"反向光晕"
  float smL = luma(textureLod(u_tex, uv, u_lodBase + 1.0).rgb);
  float d = clamp(Lraw - smL, -u_p[5].x, u_p[5].x) * u_p[4].w
          * (1.0 + 0.8 * wEye) * (1.0 - 0.45 * wSkin);
  e += d;

  // 5c. 皮肤柔化：把高频往 mip 低频拉，只作用在皮肤上，强度由"人像优化"控制
  float soften = clamp(u_p[7].z, 0.0, 1.0) * wSkin;
  e += (blurL - Lraw) * soften;

  // 6. 色度运算（Oklab）
  vec3 lin2 = srgbToLinear(max(e, 0.0));
  vec3 lab = linearToOklab(max(lin2, 0.0));

  float satMul = u_p[2].x * (
      1.0
    + wSkin * (u_p[2].y - 1.0)
    + wSky * (u_p[2].z - 1.0)
    + wGreen * (u_p[2].w - 1.0)
    + wRest * (u_p[3].x - 1.0)
  );
  lab.yz *= satMul;

  float hueShift = u_p[3].y * wSkin + u_p[3].z * wSky + u_p[3].w * wGreen;
  lab.yz = rotate2(lab.yz, hueShift);

  // 肤色归一：向目标色相收敛，而不是冻结
  if (u_p[6].w > 1e-4 && wSkin > 1e-3) {
    float rad = length(lab.yz);
    if (rad > 0.004) {
      float ang = atan(lab.z, lab.y);
      float tgt = u_p[7].x;
      float diff = atan(sin(tgt - ang), cos(tgt - ang));
      ang += diff * wSkin * u_p[6].w;
      lab.yz = rad * vec2(cos(ang), sin(ang));
    }
  }

  lab.x += u_p[4].x * wSkin + u_p[4].y * wSky + u_p[4].z * wGreen;
  lin2 = oklabToLinear(lab);

  // 7. 输出域
  vec3 outE = linearToSrgb(max(lin2, 0.0));
  float aspect = u_res.x / max(u_res.y, 1.0);

  if (u_hasLut > 0.5 && u_p[6].z > 1e-4) {
    outE = mix(outE, lutTetrahedral(outE), u_p[6].z);
  }

  // 颗粒（高光少给）。频率与分辨率无关，保证预览与导出观感一致。
  vec2 gp = vec2(uv.x * aspect, uv.y) * (1200.0 / max(u_p[5].z, 0.5));
  float grain = hash12(gp) - 0.5;
  outE += grain * u_p[5].y * (1.0 - smoothstep(0.8, 1.0, luma(outE)));

  // 暗角
  float r = length((uv - 0.5) * vec2(aspect, 1.0)) / 0.7071;
  float vig = 1.0 - u_p[5].w * smoothstep(u_p[6].x, u_p[6].x + u_p[6].y, r);
  outE *= vig;

  // 抖动：消除 8bit 输出的天空色带
  outE += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

  outColor = vec4(clamp(outE, 0.0, 1.0), 1.0);
}