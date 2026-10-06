import { CameraEffectError, needsBackgroundImage, type CameraEffectSettings } from '../../utils/cameraEffects';

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 point = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = point;
  gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D frameTexture;
uniform sampler2D maskTexture;
uniform sampler2D backgroundTexture;
uniform vec3 backgroundColor;
uniform vec3 keyColor;
uniform vec3 keySettings;
uniform vec2 backgroundScale;
uniform int chroma;
uniform int matting;
uniform int backgroundKind;
void main() {
  vec2 point = vec2(uv.x, 1.0 - uv.y);
  vec4 foreground = texture(frameTexture, point);
  float alpha;
  if (chroma == 1) {
    vec3 channels = floor(foreground.rgb * 255.0 + 0.5);
    vec3 key = floor(keyColor * 255.0 + 0.5);
    float largest = max(channels.r, max(channels.g, channels.b));
    float smallest = min(channels.r, min(channels.g, channels.b));
    bool neutral = max(key.r, max(key.g, key.b)) - min(key.r, min(key.g, key.b)) < 16.0;
    if (!neutral && (largest < 8.0 || largest - smallest < 12.0)) {
      alpha = 1.0;
    } else {
      vec3 difference = abs(channels - key);
      float distance = neutral ? max(difference.r, max(difference.g, difference.b)) / 255.0
        : length(channels / dot(channels, vec3(1.0)) - key / dot(key, vec3(1.0))) / sqrt(2.0);
      alpha = floor(smoothstep(keySettings.x, keySettings.x + keySettings.y, distance) * 255.0 + 0.5) / 255.0;
      if (!neutral && key.g > max(key.r, key.b) && channels.g > max(channels.r, channels.b)) {
        float fringe = 1.0 - smoothstep(keySettings.x, keySettings.x + keySettings.y + 0.2, distance);
        foreground.g = floor(channels.g - (channels.g - max(channels.r, channels.b)) * keySettings.z * fringe + 0.5) / 255.0;
      }
    }
  } else {
    alpha = matting == 1 ? clamp(foreground.a, 0.0, 1.0) : texture(maskTexture, point).a * foreground.a;
  }
  vec3 background = backgroundColor;
  if (backgroundKind != 0) {
    vec4 image = texture(backgroundTexture, (point - 0.5) * backgroundScale + 0.5);
    if (backgroundKind == 2) {
      background = image.a > 0.0001 ? image.rgb / image.a : backgroundColor;
    } else {
      background = mix(background, image.rgb, image.a);
    }
  }
  outputColor = vec4(mix(background, foreground.rgb, alpha), 1.0);
}`;

const BLUR_SOURCE = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D frameTexture;
uniform sampler2D maskTexture;
void main() {
  vec4 frame = texture(frameTexture, uv);
  float weight = (1.0 - clamp(texture(maskTexture, uv).a, 0.0, 1.0)) * frame.a;
  outputColor = vec4(frame.rgb * weight, weight);
}`;

const BLUR = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D frameTexture;
uniform vec2 stepSize;
void main() {
  vec4 color = vec4(0.0);
  float total = 0.0;
  for (int index = -6; index <= 6; index++) {
    float offset = float(index) * 0.5;
    float weight = exp(-0.5 * offset * offset);
    color += texture(frameTexture, uv + float(index) * stepSize) * weight;
    total += weight;
  }
  outputColor = color / total;
}`;

interface Texture {
  handle: WebGLTexture;
  width: number;
  height: number;
  floatingPoint: boolean;
}

interface GlState {
  program: WebGLProgram | null;
  vao: WebGLVertexArrayObject | null;
  draw: WebGLFramebuffer | null;
  read: WebGLFramebuffer | null;
  viewport: [number, number, number, number];
  color: [boolean, boolean, boolean, boolean];
  active: number;
  unpackAlignment: number;
  flags: ReadonlyArray<readonly [number, boolean]>;
  textures: Array<WebGLTexture | null>;
}

function saveState(gl: WebGL2RenderingContext): GlState {
  const state: GlState = {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT), color: gl.getParameter(gl.COLOR_WRITEMASK),
    active: gl.getParameter(gl.ACTIVE_TEXTURE), unpackAlignment: gl.getParameter(gl.UNPACK_ALIGNMENT),
    flags: [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST].map(flag => [flag, gl.isEnabled(flag)] as const),
    textures: [],
  };
  for (let unit = 0; unit < 3; unit++) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    state.textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
  }
  return state;
}

function restoreState(gl: WebGL2RenderingContext, state: GlState): void {
  gl.useProgram(state.program); gl.bindVertexArray(state.vao);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.read);
  gl.viewport(...state.viewport); gl.colorMask(...state.color);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, state.unpackAlignment);
  for (const [flag, enabled] of state.flags) enabled ? gl.enable(flag) : gl.disable(flag);
  state.textures.forEach((texture, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
  });
  gl.activeTexture(state.active);
}

export class CameraGpuCompositor {
  private readonly textures: Texture[] = [];
  private readonly programs: WebGLProgram[] = [];
  private readonly shaders: WebGLShader[] = [];
  private readonly locations = new Map<WebGLProgram, Map<string, WebGLUniformLocation>>();
  private readonly frame: Texture;
  private readonly mask: Texture;
  private readonly image: Texture;
  private readonly blurSource: Texture;
  private readonly blurHorizontal: Texture;
  private readonly blurVertical: Texture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vertexArray: WebGLVertexArrayObject | null = null;
  private readonly composite: WebGLProgram;
  private readonly blur: WebGLProgram;
  private readonly prepareBlur: WebGLProgram;
  private background: ImageBitmap | null = null;
  private disposed = false;

  public static create(): CameraGpuCompositor | null {
    const canvas = new OffscreenCanvas(2, 2);
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
    });
    if (!gl) {
      console.warn('[CameraEffects] WebGL2 composition unavailable; using the CPU compositor.');
      return null;
    }
    return new CameraGpuCompositor(canvas, gl);
  }

  public static forMatting(gl: WebGLRenderingContext): CameraGpuCompositor {
    if (!(gl instanceof WebGL2RenderingContext) || !(gl.canvas instanceof OffscreenCanvas)) {
      throw new CameraEffectError('unsupported');
    }
    const state = saveState(gl);
    try { return new CameraGpuCompositor(gl.canvas, gl, false); }
    finally { restoreState(gl, state); }
  }

  private constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly gl: WebGL2RenderingContext,
    private readonly ownsContext = true,
  ) {
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new CameraEffectError('processing');
    this.framebuffer = framebuffer;
    try {
      this.vertexArray = gl.createVertexArray();
      if (!this.vertexArray) throw new CameraEffectError('processing');
      this.composite = this.program(COMPOSITE);
      this.blur = this.program(BLUR);
      this.prepareBlur = this.program(BLUR_SOURCE);
      this.frame = this.texture();
      this.mask = this.texture();
      this.image = this.texture();
      const floatingPoint = !!gl.getExtension('EXT_color_buffer_float');
      this.blurSource = this.texture(floatingPoint);
      this.blurHorizontal = this.texture(floatingPoint);
      this.blurVertical = this.texture(floatingPoint);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  public render(
    bitmap: ImageBitmap,
    settings: CameraEffectSettings,
    mask: ImageData | null,
    background: ImageBitmap | null,
  ): ImageBitmap {
    this.draw(bitmap, settings, mask, background);
    return this.canvas.transferToImageBitmap();
  }

  public async renderMatting(
    bitmap: ImageBitmap,
    settings: CameraEffectSettings,
    foreground: WebGLTexture,
    background: ImageBitmap | null,
    waitForGpu: () => Promise<void>,
  ): Promise<ImageBitmap> {
    const state = saveState(this.gl);
    try {
      this.draw(bitmap, settings, null, background, foreground);
      await waitForGpu();
      if (this.gl.isContextLost() || this.gl.getError() !== this.gl.NO_ERROR) throw new CameraEffectError('processing');
      return await createImageBitmap(this.canvas);
    } finally { restoreState(this.gl, state); }
  }

  private draw(
    bitmap: ImageBitmap,
    settings: CameraEffectSettings,
    mask: ImageData | null,
    background: ImageBitmap | null,
    matte?: WebGLTexture,
  ): void {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) throw new CameraEffectError('processing');
    if (settings.mode === 'off' || (settings.mode !== 'chroma' && !mask && !matte)) throw new CameraEffectError('processing');
    if (needsBackgroundImage(settings) && !background) throw new CameraEffectError('imageMissing');
    if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
      this.canvas.width = bitmap.width;
      this.canvas.height = bitmap.height;
    }
    gl.bindVertexArray(this.vertexArray);
    gl.colorMask(true, true, true, true);
    for (const flag of [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST]) gl.disable(flag);
    gl.activeTexture(gl.TEXTURE0);
    this.upload(this.frame, bitmap);
    if (mask && settings.mode !== 'chroma') this.upload(this.mask, mask);
    if (background && background !== this.background) {
      this.upload(this.image, background);
      this.background = background;
    }
    const blurred = settings.mode === 'blur';
    if (blurred) this.blurBackground(bitmap.width, bitmap.height, settings.blurRadius, matte ?? this.mask.handle);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bitmap.width, bitmap.height);
    gl.useProgram(this.composite);
    this.bind(this.composite, 'frameTexture', matte ?? this.frame.handle, 0);
    this.bind(this.composite, 'maskTexture', matte ?? this.mask.handle, 1);
    this.bind(this.composite, 'backgroundTexture', (blurred ? this.blurVertical : this.image).handle, 2);
    this.color('backgroundColor', settings.backgroundColor);
    this.color('keyColor', settings.keyColor);
    gl.uniform3f(this.uniform(this.composite, 'keySettings'), settings.keyTolerance / 100, settings.keySoftness / 100, settings.spillReduction / 100);
    gl.uniform1i(this.uniform(this.composite, 'chroma'), settings.mode === 'chroma' ? 1 : 0);
    gl.uniform1i(this.uniform(this.composite, 'matting'), matte ? 1 : 0);
    gl.uniform1i(this.uniform(this.composite, 'backgroundKind'), blurred ? 2 : needsBackgroundImage(settings) ? 1 : 0);
    const aspect = needsBackgroundImage(settings) && background
      ? (bitmap.width / bitmap.height) / (background.width / background.height) : 1;
    gl.uniform2f(this.uniform(this.composite, 'backgroundScale'), Math.min(1, aspect), Math.min(1, 1 / aspect));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new CameraEffectError('processing');
  }

  private blurBackground(width: number, height: number, radius: number, mask: WebGLTexture): void {
    const gl = this.gl;
    const sigma = radius * height / 720;
    const scale = Math.min(4, Math.max(1, Math.floor(sigma / 2)));
    const targetWidth = Math.max(1, Math.ceil(width / scale));
    const targetHeight = Math.max(1, Math.ceil(height / scale));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    // Exclude foreground before filtering, then normalize by the blurred
    // background weight. This prevents a second, enlarged silhouette/halo.
    this.allocate(this.blurSource, width, height);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.blurSource.handle, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new CameraEffectError('processing');
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.prepareBlur);
    this.bind(this.prepareBlur, 'frameTexture', this.frame.handle, 0);
    this.bind(this.prepareBlur, 'maskTexture', mask, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.blur);
    gl.viewport(0, 0, targetWidth, targetHeight);
    for (const [input, output, horizontal] of [
      [this.blurSource, this.blurHorizontal, true], [this.blurHorizontal, this.blurVertical, false],
    ] as const) {
      this.allocate(output, targetWidth, targetHeight);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.handle, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new CameraEffectError('processing');
      this.bind(this.blur, 'frameTexture', input.handle, 0);
      gl.uniform2f(this.uniform(this.blur, 'stepSize'), horizontal ? sigma / width / 2 : 0, horizontal ? 0 : sigma / height / 2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private color(name: string, hex: string): void {
    this.gl.uniform3f(this.uniform(this.composite, name),
      parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
  }

  private texture(floatingPoint = false): Texture {
    const gl = this.gl;
    const handle = gl.createTexture();
    if (!handle) throw new CameraEffectError('processing');
    const texture = { handle, width: 0, height: 0, floatingPoint };
    this.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.allocate(texture, 1, 1);
    return texture;
  }

  private allocate(texture: Texture, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture.handle);
    if (texture.width === width && texture.height === height) return;
    gl.texImage2D(gl.TEXTURE_2D, 0, texture.floatingPoint ? gl.RGBA16F : gl.RGBA,
      width, height, 0, gl.RGBA, texture.floatingPoint ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    texture.width = width;
    texture.height = height;
  }

  private upload(texture: Texture, source: ImageBitmap | ImageData): void {
    const gl = this.gl;
    this.allocate(texture, source.width, source.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  private bind(program: WebGLProgram, name: string, texture: WebGLTexture, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uniform(program, name), unit);
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation {
    let uniforms = this.locations.get(program);
    if (!uniforms) { uniforms = new Map(); this.locations.set(program, uniforms); }
    let location = uniforms.get(name);
    if (!location) {
      const found = this.gl.getUniformLocation(program, name);
      if (!found) throw new CameraEffectError('processing', { cause: new Error(`Missing camera shader uniform: ${name}`) });
      location = found;
      uniforms.set(name, location);
    }
    return location;
  }

  private program(fragment: string): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new CameraEffectError('processing');
    this.programs.push(program);
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new CameraEffectError('processing');
      this.shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new CameraEffectError('processing', { cause: new Error(gl.getShaderInfoLog(shader) || 'Camera shader compilation failed') });
      }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new CameraEffectError('processing', { cause: new Error(gl.getProgramInfoLog(program) || 'Camera shader linking failed') });
    }
    return program;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures) this.gl.deleteTexture(texture.handle);
    for (const program of this.programs) this.gl.deleteProgram(program);
    for (const shader of this.shaders) this.gl.deleteShader(shader);
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteVertexArray(this.vertexArray);
    this.locations.clear();
    this.background = null;
    if (this.ownsContext) {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.canvas.width = this.canvas.height = 1;
    }
  }
}
