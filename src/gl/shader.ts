/**
 * Shader 编译与诊断。
 *
 * 编译失败时抛出带行号的错误——GLSL 的默认报错几乎无法定位问题。
 */

export interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: ReadonlyMap<string, WebGLUniformLocation>;
}

function withLineNumbers(src: string): string {
  return src
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`无法创建 shader: ${label}`);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(无日志)';
    gl.deleteShader(shader);
    throw new Error(`[${label}] 编译失败:\n${log}\n\n${withLineNumbers(src)}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSrc, 'vertex');
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSrc, 'fragment');
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(无日志)';
    gl.deleteProgram(program);
    throw new Error(`program 链接失败: ${log}`);
  }

  const uniforms = new Map<string, WebGLUniformLocation>();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    // 数组 uniform 的名字形如 u_p[0]，统一按基名索引
    const base = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(program, info.name);
    if (loc) uniforms.set(base, loc);
  }

  return { program, uniforms };
}

export function deleteProgram(gl: WebGL2RenderingContext, p: Program): void {
  gl.deleteProgram(p.program);
}