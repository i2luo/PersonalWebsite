/*
 * Portfolio background scenes.
 *
 * Each scene mounts into a container element and returns a handle:
 *
 *   { destroy(): void, setPalette(palette): void }
 *
 * Palette shape: { bg, c1, c2, c3 } as hex strings. `bg` follows the site's
 * --bg-deep / mood colour; c1..c3 are the site accents.
 *
 * Public API (window.PortfolioBackgrounds):
 *   list()                          -> metadata for every registered scene
 *   mount(id, container, options)   -> Promise<handle>
 *
 * The "classic mesh" background is drawn by effects.js itself; this module
 * provides the alternative scenes selectable from the picker. Vanta NET and
 * its three.js dependency are vendored under assets/vendor/ and only loaded
 * when that scene is chosen.
 */
(function () {
  "use strict";

  const THREE_URL = "assets/vendor/three-0.134.0.min.js";
  const VANTA_NET_URL = "assets/vendor/vanta.net-0.5.24.min.js";

  const DEFAULT_PALETTE = { bg: "#091411", c1: "#8dc3a6", c2: "#6b9fd4", c3: "#9c7ac8" };
  const TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ */
  /* Colour helpers                                                      */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  function hexToRgb(hex) {
    let h = String(hex || "#000000").replace("#", "").trim();
    if (h.length === 3) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hexToInt(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (r << 16) | (g << 8) | b;
  }

  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function toGl(hex) {
    return hexToRgb(hex).map((v) => v / 255);
  }

  function normalizePalette(p) {
    return Object.assign({}, DEFAULT_PALETTE, p || {});
  }

  /* ------------------------------------------------------------------ */
  /* Shared infrastructure                                               */
  /* ------------------------------------------------------------------ */

  const scriptPromises = new Map();
  function loadScript(url) {
    if (scriptPromises.has(url)) {
      return scriptPromises.get(url);
    }
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromises.delete(url);
        reject(new Error(`Failed to load ${url}`));
      };
      document.head.appendChild(script);
    });
    scriptPromises.set(url, promise);
    return promise;
  }

  // One shared pointer tracker. Only one scene is mounted at a time, so a
  // single smoothed pointer state is enough.
  const pointer = {
    tx: window.innerWidth * 0.5,
    ty: window.innerHeight * 0.5,
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.5,
    nx: 0,
    ny: 0,
  };
  window.addEventListener(
    "pointermove",
    (event) => {
      pointer.tx = event.clientX;
      pointer.ty = event.clientY;
    },
    { passive: true }
  );

  function stepPointer(k) {
    pointer.x += (pointer.tx - pointer.x) * k;
    pointer.y += (pointer.ty - pointer.y) * k;
    pointer.nx = (pointer.x / window.innerWidth - 0.5) * 2;
    pointer.ny = (pointer.y / window.innerHeight - 0.5) * 2;
    return pointer;
  }

  // requestAnimationFrame loop that pauses while the tab is hidden and hands
  // the draw callback an elapsed time in seconds plus a clamped delta.
  function createLoop(draw) {
    let id = 0;
    let running = false;
    let last = 0;
    let elapsed = Math.random() * 100;

    function frame(now) {
      if (!running) return;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
      last = now;
      elapsed += dt;
      draw(elapsed, dt);
      id = window.requestAnimationFrame(frame);
    }

    function onVisibility() {
      if (document.hidden) {
        window.cancelAnimationFrame(id);
        last = 0;
      } else if (running) {
        id = window.requestAnimationFrame(frame);
      }
    }

    return {
      start() {
        if (running) return;
        running = true;
        last = 0;
        document.addEventListener("visibilitychange", onVisibility);
        id = window.requestAnimationFrame(frame);
      },
      stop() {
        running = false;
        window.cancelAnimationFrame(id);
        document.removeEventListener("visibilitychange", onVisibility);
      },
      once() {
        draw(elapsed, 1 / 60);
      },
    };
  }

  function fillLayer(el) {
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
    });
    return el;
  }

  function createCanvas2D(container, { scale = 1, maxDpr = 2 } = {}) {
    const canvas = fillLayer(document.createElement("canvas"));
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const state = { canvas, ctx, w: 0, h: 0, dpr: 1, onResize: null };

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * scale;
      state.w = container.clientWidth || window.innerWidth;
      state.h = container.clientHeight || window.innerHeight;
      state.dpr = dpr;
      canvas.width = Math.max(1, Math.floor(state.w * dpr));
      canvas.height = Math.max(1, Math.floor(state.h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (state.onResize) state.onResize();
    }

    resize();
    const observer = new ResizeObserver(() => resize());
    observer.observe(container);
    state.destroy = () => {
      observer.disconnect();
      canvas.remove();
    };
    return state;
  }

  /* ------------------------------------------------------------------ */
  /* WebGL full-screen shader layer                                      */
  /* ------------------------------------------------------------------ */

  const VERT_SRC = "attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }";

  // Ashima / Ian McEwan simplex noise (MIT).
  const NOISE_GLSL = `
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
  `;

  const SHADER_HEADER = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform vec3 u_bg;
    uniform vec3 u_c1;
    uniform vec3 u_c2;
    uniform vec3 u_c3;
    ${NOISE_GLSL}
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile error: ${log}`);
    }
    return shader;
  }

  function createShaderLayer(container, fragBody, { scale = 1, maxDpr = 2 } = {}) {
    const canvas = fillLayer(document.createElement("canvas"));
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      return null;
    }
    container.appendChild(canvas);

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, SHADER_HEADER + fragBody));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = {};
    ["u_res", "u_time", "u_mouse", "u_bg", "u_c1", "u_c2", "u_c3"].forEach((name) => {
      u[name] = gl.getUniformLocation(program, name);
    });

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * scale;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    const observer = new ResizeObserver(() => resize());
    observer.observe(container);

    let lost = false;
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      lost = true;
    });

    return {
      render(time, palette, mx, my) {
        if (lost) return;
        gl.uniform2f(u.u_res, canvas.width, canvas.height);
        gl.uniform1f(u.u_time, time);
        gl.uniform2f(u.u_mouse, mx, my);
        gl.uniform3fv(u.u_bg, toGl(palette.bg));
        gl.uniform3fv(u.u_c1, toGl(palette.c1));
        gl.uniform3fv(u.u_c2, toGl(palette.c2));
        gl.uniform3fv(u.u_c3, toGl(palette.c3));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      destroy() {
        observer.disconnect();
        const ext = gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
        canvas.remove();
      },
    };
  }

  function shaderBackground(fragBody, options) {
    return (container, ctx) => {
      const layer = createShaderLayer(container, fragBody, options);
      if (!layer) {
        container.style.background = ctx.palette.bg;
        return { destroy() {}, setPalette(p) { container.style.background = p.bg; } };
      }
      let palette = ctx.palette;
      const loop = createLoop((t) => {
        const p = stepPointer(0.06);
        layer.render(t, palette, p.x / window.innerWidth, 1 - p.y / window.innerHeight);
      });
      if (ctx.reducedMotion) {
        loop.once();
      } else {
        loop.start();
      }
      return {
        destroy() {
          loop.stop();
          layer.destroy();
        },
        setPalette(p) {
          palette = p;
          if (ctx.reducedMotion) loop.once();
        },
      };
    };
  }

  /* ------------------------------------------------------------------ */
  /* Scenes                                                              */
  /* ------------------------------------------------------------------ */

  const REGISTRY = [];
  function register(def) {
    REGISTRY.push(def);
  }

  /* Fluid mesh gradient (WebGL). Four large colour blobs with noise-warped
     edges; the cursor pushes the field away from itself. */
  register({
    id: "fluid-mesh",
    name: "Fluid Mesh",
    description:
      "Four large colour blobs (mood colour + the three site accents) drift slowly while low-frequency simplex noise warps their edges into liquid shapes. Rendered at half resolution with film grain.",
    create: shaderBackground(
      `
      void main() {
        vec2 uv = gl_FragCoord.xy / u_res;
        float aspect = u_res.x / u_res.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        vec2 m = vec2(u_mouse.x * aspect, u_mouse.y);
        float t = u_time * 0.12;

        // Low-frequency warp gives the blobs their liquid edges.
        vec2 w = p + 0.16 * vec2(
          snoise(vec3(p * 1.1, t * 0.45)),
          snoise(vec3(p * 1.1 + 7.1, t * 0.45 + 2.0))
        );
        // Cursor pushes the field away from itself.
        vec2 toM = p - m;
        float mInf = exp(-dot(toM, toM) * 2.6);
        w -= toM * mInf * 0.28;

        vec2 c0 = vec2(0.28 * aspect, 0.70) + 0.10 * vec2(sin(t * 0.70), cos(t * 0.50));
        vec2 c1 = vec2(0.82 * aspect, 0.74) + 0.10 * vec2(cos(t * 0.60 + 1.0), sin(t * 0.80 + 2.0));
        vec2 c2 = vec2(0.62 * aspect, 0.22) + 0.12 * vec2(sin(t * 0.50 + 3.0), cos(t * 0.70 + 1.0));
        vec2 c3 = vec2(0.12 * aspect, 0.18) + 0.10 * vec2(cos(t * 0.80 + 2.0), sin(t * 0.60));

        float w0 = exp(-dot(w - c0, w - c0) * 3.0);
        float w1 = exp(-dot(w - c1, w - c1) * 3.4);
        float w2 = exp(-dot(w - c2, w - c2) * 3.2);
        float w3 = exp(-dot(w - c3, w - c3) * 3.6);

        vec3 col = u_bg;
        col = mix(col, u_c1 * 0.66, w0 * 0.95);
        col = mix(col, u_c2 * 0.68, w1 * 0.9);
        col = mix(col, u_c3 * 0.62, w2 * 0.9);
        col = mix(col, mix(u_c1, u_c2, 0.5) * 0.5, w3 * 0.85);

        // Luminous core in the mint blob and a faint cursor halo.
        col += u_c1 * exp(-dot(w - c0, w - c0) * 11.0) * 0.16;
        col += u_c1 * mInf * 0.05;

        float vig = smoothstep(0.4, 1.1, length(uv - 0.5) * 1.3);
        col = mix(col, u_bg, vig * 0.5);

        col += (hash21(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.02;
        gl_FragColor = vec4(col, 1.0);
      }
      `,
      { scale: 0.5, maxDpr: 1.5 }
    ),
  });

  /* Aurora borealis (WebGL). Three noise-driven curtains over a starfield. */
  register({
    id: "aurora-shader",
    name: "Aurora Borealis",
    description:
      "Three layered noise-driven curtains with a bright lower edge fading upward from mint to blue to violet, over a twinkling hashed starfield. Pointer gives subtle parallax.",
    create: shaderBackground(
      `
      void main() {
        vec2 uv = gl_FragCoord.xy / u_res;
        float aspect = u_res.x / u_res.y;
        vec2 m = u_mouse - 0.5;
        float t = u_time;

        vec3 col = mix(u_bg, u_bg * 0.55 + u_c2 * 0.06, uv.y);

        vec2 sp = (gl_FragCoord.xy / u_res.y + m * 0.02) * 70.0;
        vec2 cell = floor(sp);
        vec2 f = fract(sp) - 0.5;
        float rnd = hash21(cell);
        vec2 off = (vec2(hash21(cell + 7.1), hash21(cell + 3.7)) - 0.5) * 0.7;
        float star = smoothstep(0.12, 0.0, length(f - off)) * step(0.972, rnd);
        float tw = 0.55 + 0.45 * sin(t * (1.0 + rnd * 2.0) + rnd * 80.0);
        col += vec3(0.85, 0.92, 1.0) * star * tw * smoothstep(0.08, 0.6, uv.y) * 0.85;

        vec3 glow = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float speed = 0.05 + fi * 0.02;
          float x = uv.x * aspect * (1.0 + fi * 0.3) + fi * 4.7 + m.x * (0.15 + fi * 0.1);
          float center = 0.42 + fi * 0.09
            + 0.16 * snoise(vec3(x * 0.7, fi * 3.3, t * speed))
            + m.y * 0.05;
          float d = uv.y - center;
          float below = exp(-max(-d, 0.0) * 22.0);
          float above = exp(-max(d, 0.0) * (4.2 - fi * 0.8));
          float curtain = below * above;
          float streak = 0.5 + 0.5 * snoise(vec3(x * 6.0, fi * 9.0, t * 0.25));
          streak = pow(streak, 1.5);
          float density = 0.45 + 0.55 * smoothstep(-0.4, 0.6, snoise(vec3(x * 1.3 + 10.0, fi * 5.0, t * 0.09)));
          float inten = curtain * streak * density;
          vec3 c = mix(u_c1, u_c2, clamp(d * 6.0 + 0.15, 0.0, 1.0));
          c = mix(c, u_c3, clamp(d * 4.0 - 0.1, 0.0, 1.0));
          glow += c * inten * (0.75 - fi * 0.16);
        }
        col += glow;

        col = mix(col, u_bg, smoothstep(0.3, 0.0, uv.y) * 0.6);
        col += (hash21(gl_FragCoord.xy + fract(t) * 37.0) - 0.5) * 0.015;
        gl_FragColor = vec4(col, 1.0);
      }
      `,
      { scale: 0.6, maxDpr: 1.5 }
    ),
  });

  /* Starfield with shooting stars (canvas 2D). */
  register({
    id: "shooting-stars",
    name: "Shooting Stars",
    description:
      "A few hundred twinkling stars with depth-based parallax, three soft nebula glows in the accent colours, and a meteor every few seconds.",
    create(container, ctx) {
      const layer = createCanvas2D(container, { maxDpr: 1.5 });
      let palette = ctx.palette;
      let stars = [];
      let meteors = [];
      let nextMeteor = 1.2;

      function seed() {
        const count = clamp(Math.round((layer.w * layer.h) / 3800), 140, 420);
        stars = Array.from({ length: count }, () => ({
          x: Math.random(),
          y: Math.random(),
          r: 0.35 + Math.pow(Math.random(), 2.2) * 1.5,
          a: 0.25 + Math.random() * 0.6,
          ph: Math.random() * TAU,
          sp: 0.4 + Math.random() * 1.6,
          z: 0.15 + Math.random() * 0.85,
          tint: Math.random(),
        }));
      }
      seed();
      layer.onResize = seed;

      function spawnMeteor() {
        const dir = Math.random() > 0.5 ? 1 : -1;
        const angle = (22 + Math.random() * 16) * (Math.PI / 180);
        const speed = 700 + Math.random() * 500;
        meteors.push({
          x: Math.random() * layer.w,
          y: -20 + Math.random() * layer.h * 0.45,
          ux: Math.cos(angle) * dir,
          uy: Math.sin(angle),
          speed,
          len: 140 + Math.random() * 140,
          life: 0.9 + Math.random() * 0.7,
          age: 0,
        });
      }

      function nebula(c, x, y, r, color, a) {
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(color, a));
        g.addColorStop(0.5, rgba(color, a * 0.35));
        g.addColorStop(1, rgba(color, 0));
        c.fillStyle = g;
        c.fillRect(0, 0, layer.w, layer.h);
      }

      const loop = createLoop((t, dt) => {
        const { ctx: c, w, h } = layer;
        const p = stepPointer(0.05);
        const big = Math.max(w, h);

        c.globalCompositeOperation = "source-over";
        c.fillStyle = palette.bg;
        c.fillRect(0, 0, w, h);

        c.globalCompositeOperation = "lighter";
        nebula(c, w * (0.22 + Math.sin(t * 0.05) * 0.03), h * 0.3, big * 0.42, palette.c1, 0.11);
        nebula(c, w * 0.8, h * (0.66 + Math.cos(t * 0.04) * 0.03), big * 0.4, palette.c3, 0.1);
        nebula(c, w * 0.62, h * 0.12, big * 0.3, palette.c2, 0.08);

        for (let i = 0; i < stars.length; i += 1) {
          const s = stars[i];
          const tw = 0.6 + 0.4 * Math.sin(t * s.sp + s.ph);
          const x = s.x * w - p.nx * s.z * 16;
          const y = s.y * h - p.ny * s.z * 12;
          const alpha = s.a * tw;
          c.fillStyle = s.tint > 0.82 ? rgba(palette.c1, alpha) : `rgba(233, 241, 255, ${alpha})`;
          c.beginPath();
          c.arc(x, y, s.r, 0, TAU);
          c.fill();
          if (s.r > 1.35) {
            const g = c.createRadialGradient(x, y, 0, x, y, s.r * 6);
            g.addColorStop(0, `rgba(233, 241, 255, ${alpha * 0.35})`);
            g.addColorStop(1, "rgba(233, 241, 255, 0)");
            c.fillStyle = g;
            c.beginPath();
            c.arc(x, y, s.r * 6, 0, TAU);
            c.fill();
          }
        }

        nextMeteor -= dt;
        if (nextMeteor <= 0) {
          spawnMeteor();
          nextMeteor = 1.6 + Math.random() * 3.4;
        }
        meteors = meteors.filter((mt) => mt.age < mt.life && mt.x > -300 && mt.x < w + 300 && mt.y < h + 300);
        c.lineCap = "round";
        for (let i = 0; i < meteors.length; i += 1) {
          const mt = meteors[i];
          mt.age += dt;
          mt.x += mt.ux * mt.speed * dt;
          mt.y += mt.uy * mt.speed * dt;
          const fade = Math.min(1, mt.age * 5) * Math.min(1, (mt.life - mt.age) * 2.5);
          const tx = mt.x - mt.ux * mt.len;
          const ty = mt.y - mt.uy * mt.len;
          const g = c.createLinearGradient(mt.x, mt.y, tx, ty);
          g.addColorStop(0, `rgba(255, 255, 255, ${0.95 * fade})`);
          g.addColorStop(0.25, rgba(palette.c1, 0.55 * fade));
          g.addColorStop(1, rgba(palette.c2, 0));
          c.strokeStyle = g;
          c.lineWidth = 1.8;
          c.beginPath();
          c.moveTo(mt.x, mt.y);
          c.lineTo(tx, ty);
          c.stroke();
          const hg = c.createRadialGradient(mt.x, mt.y, 0, mt.x, mt.y, 12);
          hg.addColorStop(0, `rgba(255, 255, 255, ${0.6 * fade})`);
          hg.addColorStop(1, "rgba(255, 255, 255, 0)");
          c.fillStyle = hg;
          c.beginPath();
          c.arc(mt.x, mt.y, 12, 0, TAU);
          c.fill();
        }
        c.globalCompositeOperation = "source-over";
      });
      ctx.reducedMotion ? loop.once() : loop.start();
      return {
        destroy() {
          loop.stop();
          layer.destroy();
        },
        setPalette(p) {
          palette = p;
          if (ctx.reducedMotion) loop.once();
        },
      };
    },
  });

  /* Vanta NET (three.js). Lazy-loads the vendored three.js r134 + effect. */
  register({
    id: "vanta-net",
    name: "Vanta Net",
    description:
      "Three.js point cloud with distance-based links, rotating slowly in 3D and pulling toward the mouse.",
    async create(container, ctx) {
      await loadScript(THREE_URL);
      await loadScript(VANTA_NET_URL);
      const factory = window.VANTA && window.VANTA.NET;
      if (!factory) {
        throw new Error("Vanta NET did not register");
      }
      const el = fillLayer(document.createElement("div"));
      container.appendChild(el);

      let instance = null;
      function build(palette) {
        if (instance) {
          instance.destroy();
        }
        instance = factory({
          el,
          THREE: window.THREE,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200,
          minWidth: 200,
          scale: 1,
          scaleMobile: 1,
          color: hexToInt(palette.c1),
          backgroundColor: hexToInt(palette.bg),
          points: 10,
          maxDistance: 22,
          spacing: 17,
          showDots: true,
        });
        if (ctx.reducedMotion) {
          // Vanta has no pause API; stop its loop after the first frame.
          window.setTimeout(() => {
            if (instance && instance.req) window.cancelAnimationFrame(instance.req);
          }, 400);
        }
      }
      build(ctx.palette);

      return {
        destroy() {
          if (instance) instance.destroy();
          instance = null;
          el.remove();
        },
        setPalette(p) {
          // Vanta bakes colours in at init, so rebuild on palette changes.
          build(p);
        },
      };
    },
  });

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  window.PortfolioBackgrounds = {
    list() {
      return REGISTRY.map(({ create, ...meta }) => meta);
    },
    async mount(id, container, options = {}) {
      const def = REGISTRY.find((d) => d.id === id);
      if (!def) {
        throw new Error(`Unknown background "${id}"`);
      }
      const ctx = {
        palette: normalizePalette(options.palette),
        reducedMotion:
          typeof options.reducedMotion === "boolean"
            ? options.reducedMotion
            : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      };
      const handle = await def.create(container, ctx);
      return {
        id,
        destroy() {
          handle.destroy();
        },
        setPalette(p) {
          return handle.setPalette(normalizePalette(p));
        },
      };
    },
  };
})();
