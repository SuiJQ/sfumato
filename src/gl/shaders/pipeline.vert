#version 300 es
// 全屏三角形：无需顶点缓冲，靠 gl_VertexID 生成
out vec2 v_uv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    // 纹理 v=0 对应图像顶部，而 clip y=-1 是屏幕底部，这里翻转一次
  v_uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}