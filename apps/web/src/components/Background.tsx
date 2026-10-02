import { useEffect, useRef } from "react";

const vertex = `attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

/** Slow organic flow field in the Arbor palette, with a soft halo that follows the pointer. */
const fragment = `precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 a0 = x - floor(x + 0.5);
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 mouse = u_mouse.x <= 0.0 ? vec2(0.5) : u_mouse / u_resolution;
  vec3 bg = vec3(0.035, 0.052, 0.044);
  vec3 emerald = vec3(0.07, 0.19, 0.14);
  vec3 teal = vec3(0.10, 0.33, 0.26);
  float dist = length(uv - mouse);
  float wave = sin(dist * 18.0 - u_time * 2.5) * exp(-dist * 3.5);
  float t = u_time * 0.25;
  vec2 flow = uv * 2.2 + vec2(t * 0.15, -t * 0.1);
  float n1 = snoise(flow + wave * 0.18);
  float n2 = snoise(flow * 1.8 - vec2(n1 * 0.4, t * 0.2));
  float energy = smoothstep(-0.4, 0.8, n2 + 0.15 / (dist + 0.25));
  vec3 col = mix(bg, emerald, smoothstep(-0.2, 0.7, n1));
  col = mix(col, teal, energy * 0.4);
  col += teal * exp(-dist * 4.0) * 0.22;
  float grain = fract(sin(dot(uv * (u_time + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.022;
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * Full-screen WebGL backdrop. Renders a single still frame when the user prefers reduced motion, pauses while
 * the tab is hidden, and caps resolution so it stays cheap; without WebGL the CSS gradient behind it shows.
 */
export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { antialias: false, powerPreference: "low-power" });
    if (!canvas || !gl) return;
    const compile = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uTime = gl.getUniformLocation(program, "u_time");
    const uResolution = gl.getUniformLocation(program, "u_resolution");
    const uMouse = gl.getUniformLocation(program, "u_mouse");

    // Half resolution is plenty for a soft, blurry field and keeps laptops cool.
    const scale = Math.min(window.devicePixelRatio || 1, 1) * 0.5;
    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * scale)), h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const mouse = { x: -1, y: -1 };
    const onMove = (e: PointerEvent) => { mouse.x = (e.clientX / window.innerWidth) * canvas.width; mouse.y = (1 - e.clientY / window.innerHeight) * canvas.height; };
    window.addEventListener("pointermove", onMove, { passive: true });

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const draw = (ms: number) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uTime, ms / 1000);
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const loop = (ms: number) => { draw(ms); raf = requestAnimationFrame(loop); };
    const start = () => {
      cancelAnimationFrame(raf);
      if (reduced.matches || document.hidden) draw(12_000);
      else raf = requestAnimationFrame(loop);
    };
    start();
    document.addEventListener("visibilitychange", start);
    reduced.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", start);
      reduced.removeEventListener("change", start);
    };
  }, []);
  return <div className="backdrop" aria-hidden="true"><canvas ref={ref} /><div className="backdrop-grid" /><div className="backdrop-glow" /></div>;
}
