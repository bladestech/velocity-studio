// GPU RGB -> NV12 (BT.709, limited range) converter.
// Chromium's VideoFrame.copyTo() cannot output YUV, and shipping raw RGBA to a hardware encoder
// would cost ~500 MB/s at 1080p60. This renders the source canvas through a WebGL2 shader into a
// single R8 target laid out exactly like an NV12 frame (Y plane, then interleaved UV plane) and
// reads it back asynchronously through a PBO + fence, so only 1.5 bytes/pixel leave the GPU.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;
out vec4 o;
vec3 yuv(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float u = (c.b - y) / 1.8556;
  float v = (c.r - y) / 1.5748;
  return vec3(16.0 / 255.0 + y * 219.0 / 255.0,
              128.0 / 255.0 + u * 224.0 / 255.0,
              128.0 / 255.0 + v * 224.0 / 255.0);
}
void main() {
  vec2 p = floor(gl_FragCoord.xy);            // p.y = memory row (row 0 = first byte of the frame)
  float val;
  if (p.y < uSize.y) {
    val = yuv(texture(uTex, (p + 0.5) / uSize).rgb).x;
  } else {
    float r = p.y - uSize.y;
    float pair = floor(p.x * 0.5);
    float isV = mod(p.x, 2.0);
    // centre of the 2x2 block -> bilinear filter averages the four pixels
    vec3 c = yuv(texture(uTex, vec2(pair * 2.0 + 1.0, r * 2.0 + 1.0) / uSize).rgb);
    val = isV < 0.5 ? c.y : c.z;
  }
  o = vec4(val, 0.0, 0.0, 1.0);
}`;

export class Nv12Converter {
  constructor(width, height) {
    if (width % 2 || height % 2) throw new Error('NV12 needs even dimensions');
    this.w = width;
    this.h = height;
    this.size = (width * height * 3) / 2;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 4;
    this.canvas.height = 4;
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Link error: ${gl.getProgramInfoLog(prog)}`);
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), width, height);
    this.vao = gl.createVertexArray();

    this.src = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, (height * 3) / 2);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('R8 render target unsupported');

    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.size, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, width, (height * 3) / 2);
  }

  /** Convert `source` (a canvas of width x height) into `out` (Uint8Array of `size` bytes). */
  async convert(source, out) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, this.w, (this.h * 3) / 2, gl.RED, gl.UNSIGNED_BYTE, 0);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    for (let i = 0; i < 2000; i++) {
      const st = gl.clientWaitSync(sync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) break;
      if (st === gl.WAIT_FAILED) { gl.deleteSync(sync); throw new Error('GPU fence failed'); }
      await new Promise((r) => setTimeout(r, 0));
    }
    gl.deleteSync(sync);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return out;
  }

  dispose() {
    const gl = this.gl;
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
  }
}
