(function initAmbientEffects() {
  const html = document.documentElement;
  const bg = document.querySelector("#ambient-bg");
  const canvas = document.querySelector("#ambient-canvas");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const CURSOR_FX_STORAGE_KEY = "portfolio-cursor-fx-v1";
  const CURSOR_FX_MODES = [
    { id: "glow", label: "Spotlight Glow" },
    { id: "ribbon", label: "Ribbon Trail" },
    { id: "dots", label: "Trailing Dots" },
    { id: "comet", label: "Comet Sparks" },
    { id: "aurora", label: "Aurora Trail" },
    { id: "ripple", label: "Pulse Rings" },
    { id: "stardust", label: "Stardust Field" },
    { id: "constellation", label: "Constellation" },
    { id: "beam", label: "Light Beam" },
    { id: "off", label: "Off" },
  ];
  const FX_COLORS = [
    [141, 195, 166],
    [107, 159, 212],
    [156, 122, 200],
  ];

  let scrollMax = 1;
  let pointerX = 0;
  let pointerY = 0;
  let targetX = 0;
  let targetY = 0;
  let cursorX = window.innerWidth * 0.5;
  let cursorY = window.innerHeight * 0.5;
  let targetCursorX = cursorX;
  let targetCursorY = cursorY;
  let prevCursorX = cursorX;
  let prevCursorY = cursorY;
  let velX = 0;
  let velY = 0;
  let beamAngle = 0;
  let rafId = 0;
  let cursorFxRafId = 0;
  let cursorFxMode = "glow";
  let cursorFxCanvas = null;
  let cursorFxCtx = null;
  let cursorFxWidth = 0;
  let cursorFxHeight = 0;
  let lastFrameTime = 0;
  let trail = [];
  let dots = [];
  let particles = [];
  let ripples = [];
  let stardust = [];
  let nodes = [];
  let lastRippleAt = 0;
  const TRAIL_MAX = 64;

  function updateScrollVars() {
    const y = window.scrollY;
    scrollMax = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const percent = Math.min(Math.max(y / Math.min(scrollMax, window.innerHeight * 1.2), 0), 1);
    html.style.setProperty("--scroll-y", `${y}px`);
    html.style.setProperty("--scroll-y-percent", String(percent));
    html.classList.toggle("scrolled", y > 48);
  }

  function updatePointerVars(event) {
    const x = (event.clientX / window.innerWidth - 0.5) * 2;
    const y = (event.clientY / window.innerHeight - 0.5) * 2;
    targetX = x;
    targetY = y;
    targetCursorX = event.clientX;
    targetCursorY = event.clientY;
  }

  function tickPointer() {
    pointerX += (targetX - pointerX) * 0.08;
    pointerY += (targetY - pointerY) * 0.08;
    html.style.setProperty("--tx", `${pointerX * 14}px`);
    html.style.setProperty("--ty", `${pointerY * 10}px`);
    html.style.setProperty("--parallax-x", String(pointerX));
    html.style.setProperty("--parallax-y", String(pointerY));
    rafId = window.requestAnimationFrame(tickPointer);
  }

  function initMeshCanvas() {
    if (!canvas || prefersReducedMotion) {
      return null;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const palette = [
      { x: 0.18, y: 0.22, r: 0.42, color: [28, 89, 74] },
      { x: 0.78, y: 0.18, r: 0.38, color: [52, 72, 110] },
      { x: 0.62, y: 0.72, r: 0.45, color: [141, 195, 166] },
      { x: 0.22, y: 0.78, r: 0.36, color: [90, 52, 120] },
    ];

    let width = 0;
    let height = 0;
    let start = performance.now();

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(now) {
      const t = (now - start) * 0.00015;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#091411";
      ctx.fillRect(0, 0, width, height);

      palette.forEach((blob, index) => {
        const drift = Math.sin(t + index * 1.4) * 0.06;
        const driftY = Math.cos(t * 0.9 + index) * 0.05;
        const px =
          (blob.x + drift + pointerX * 0.04) * width +
          parseFloat(getComputedStyle(html).getPropertyValue("--tx")) * 0.15;
        const py =
          (blob.y + driftY + pointerY * 0.04) * height +
          parseFloat(getComputedStyle(html).getPropertyValue("--ty")) * 0.12;
        const radius = blob.r * Math.min(width, height);

        const gradient = ctx.createRadialGradient(px, py, 0, px, py, radius);
        gradient.addColorStop(0, `rgba(${blob.color.join(",")}, 0.55)`);
        gradient.addColorStop(0.55, `rgba(${blob.color.join(",")}, 0.18)`);
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      });

      window.requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener("resize", resize);
    window.requestAnimationFrame(draw);
    return resize;
  }

  function initRevealObserver() {
    const items = document.querySelectorAll(".reveal");
    if (!items.length) {
      return;
    }

    if (prefersReducedMotion) {
      items.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );

    items.forEach((el, index) => {
      el.style.setProperty("--reveal-delay", `${Math.min(index * 70, 420)}ms`);
      observer.observe(el);
    });
  }

  function initScrollCue() {
    document.querySelectorAll(".scroll-cue").forEach((button) => {
      button.addEventListener("click", () => {
        const target = document.querySelector(".page-content") || document.querySelector(".page-hero");
        const next = target?.nextElementSibling;
        (next || target)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function readCursorFxMode() {
    try {
      const stored = localStorage.getItem(CURSOR_FX_STORAGE_KEY);
      if (stored && CURSOR_FX_MODES.some((mode) => mode.id === stored)) {
        return stored;
      }
    } catch {
      // Ignore storage errors.
    }
    return "glow";
  }

  function writeCursorFxMode(mode) {
    try {
      localStorage.setItem(CURSOR_FX_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors.
    }
  }

  function applyCursorFxMode(mode) {
    cursorFxMode = mode;
    document.body.classList.toggle("cursor-fx-off", mode === "off");
    writeCursorFxMode(mode);

    if (cursorFxCtx) {
      cursorFxCtx.clearRect(0, 0, cursorFxWidth, cursorFxHeight);
    }

    if (mode === "ripple") {
      ripples = [];
    } else if (mode === "comet") {
      particles = [];
    } else if (mode === "dots") {
      seedDots();
    } else if (mode === "stardust") {
      seedStardust();
    } else if (mode === "constellation") {
      seedNodes();
    }
  }

  function seedDots() {
    dots = Array.from({ length: 22 }, () => ({ x: cursorX, y: cursorY }));
  }

  function seedStardust() {
    const count = Math.round((cursorFxWidth * cursorFxHeight) / 16000) || 80;
    stardust = Array.from({ length: Math.min(Math.max(count, 60), 160) }, () => ({
      x: Math.random() * cursorFxWidth,
      y: Math.random() * cursorFxHeight,
      vx: 0,
      vy: 0,
      size: 0.8 + Math.random() * 1.8,
      hue: Math.random() > 0.45 ? FX_COLORS[0] : FX_COLORS[1],
    }));
  }

  function seedNodes() {
    const count = Math.round((cursorFxWidth * cursorFxHeight) / 26000) || 50;
    nodes = Array.from({ length: Math.min(Math.max(count, 40), 90) }, () => ({
      x: Math.random() * cursorFxWidth,
      y: Math.random() * cursorFxHeight,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
    }));
  }

  function resizeCursorFxCanvas() {
    if (!cursorFxCanvas || !cursorFxCtx) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cursorFxWidth = window.innerWidth;
    cursorFxHeight = window.innerHeight;
    cursorFxCanvas.width = Math.floor(cursorFxWidth * dpr);
    cursorFxCanvas.height = Math.floor(cursorFxHeight * dpr);
    cursorFxCanvas.style.width = `${cursorFxWidth}px`;
    cursorFxCanvas.style.height = `${cursorFxHeight}px`;
    cursorFxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cursorFxMode === "stardust") {
      seedStardust();
    } else if (cursorFxMode === "constellation") {
      seedNodes();
    }
  }

  function drawCursorGlow(ctx, x, y) {
    ctx.globalCompositeOperation = "lighter";
    const radius = Math.min(cursorFxWidth, cursorFxHeight) * 0.32;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, "rgba(141, 195, 166, 0.3)");
    gradient.addColorStop(0.35, "rgba(107, 159, 212, 0.14)");
    gradient.addColorStop(0.72, "rgba(120, 90, 170, 0.06)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cursorFxWidth, cursorFxHeight);
  }

  function drawCursorRibbon(ctx) {
    if (trail.length < 2) {
      return;
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < trail.length; i += 1) {
      const prev = trail[i - 1];
      const point = trail[i];
      const t = i / trail.length;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = `rgba(141, 195, 166, ${0.22 * t})`;
      ctx.lineWidth = 16 * t;
      ctx.stroke();
      ctx.strokeStyle = `rgba(190, 230, 255, ${0.4 * t})`;
      ctx.lineWidth = 5 * t;
      ctx.stroke();
    }
  }

  function drawCursorDots(ctx) {
    if (!dots.length) {
      seedDots();
    }
    dots[0].x += (cursorX - dots[0].x) * 0.4;
    dots[0].y += (cursorY - dots[0].y) * 0.4;
    for (let i = 1; i < dots.length; i += 1) {
      dots[i].x += (dots[i - 1].x - dots[i].x) * 0.4;
      dots[i].y += (dots[i - 1].y - dots[i].y) * 0.4;
    }

    ctx.globalCompositeOperation = "lighter";
    for (let i = dots.length - 1; i >= 0; i -= 1) {
      const dot = dots[i];
      const t = 1 - i / dots.length;
      const radius = 2 + 11 * t;
      const color = FX_COLORS[i % FX_COLORS.length];
      const gradient = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, radius * 2.2);
      gradient.addColorStop(0, `rgba(${color.join(",")}, ${0.5 * t + 0.1})`);
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, radius * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCursorComet(ctx, dt) {
    const speed = Math.hypot(velX, velY);
    const emitCount = Math.min(Math.round(speed / 6), 6);
    for (let i = 0; i < emitCount; i += 1) {
      const color = FX_COLORS[Math.floor(Math.random() * FX_COLORS.length)];
      particles.push({
        x: cursorX + (Math.random() - 0.5) * 6,
        y: cursorY + (Math.random() - 0.5) * 6,
        vx: -velX * 0.12 + (Math.random() - 0.5) * 1.4,
        vy: -velY * 0.12 + (Math.random() - 0.5) * 1.4,
        life: 1,
        decay: 0.012 + Math.random() * 0.02,
        size: 1.4 + Math.random() * 2.6,
        color,
      });
    }
    if (particles.length > 600) {
      particles.splice(0, particles.length - 600);
    }

    ctx.globalCompositeOperation = "lighter";
    particles = particles.filter((p) => p.life > 0);
    particles.forEach((p) => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.02 * dt;
      p.life -= p.decay * dt;
      const radius = p.size * Math.max(p.life, 0);
      if (radius <= 0) {
        return;
      }
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2.4);
      gradient.addColorStop(0, `rgba(${p.color.join(",")}, ${0.7 * p.life})`);
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawCursorAurora(ctx) {
    if (trail.length < 2) {
      return;
    }
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < trail.length; i += 2) {
      const point = trail[i];
      const t = i / trail.length;
      const wobble = Math.sin((performance.now() * 0.002) + i * 0.4) * 14;
      const color = FX_COLORS[Math.floor((i / trail.length) * FX_COLORS.length) % FX_COLORS.length];
      const radius = 40 + 70 * t;
      const gradient = ctx.createRadialGradient(
        point.x + wobble,
        point.y - wobble,
        0,
        point.x + wobble,
        point.y - wobble,
        radius
      );
      gradient.addColorStop(0, `rgba(${color.join(",")}, ${0.16 * t})`);
      gradient.addColorStop(0.6, `rgba(${color.join(",")}, ${0.06 * t})`);
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, cursorFxWidth, cursorFxHeight);
    }
  }

  function drawCursorRipples(ctx, dt) {
    const speed = Math.hypot(velX, velY);
    const now = performance.now();
    if (speed > 2 && now - lastRippleAt > 110) {
      ripples.push({ x: cursorX, y: cursorY, radius: 10, alpha: 0.45, width: 2.4 });
      lastRippleAt = now;
    }

    ctx.globalCompositeOperation = "lighter";
    ripples = ripples.filter((ripple) => ripple.alpha > 0.02);
    ripples.forEach((ripple) => {
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(141, 195, 166, ${ripple.alpha})`;
      ctx.lineWidth = ripple.width;
      ctx.stroke();
      ripple.radius += 2.8 * dt;
      ripple.alpha *= Math.pow(0.965, dt);
      ripple.width *= Math.pow(0.992, dt);
    });

    const hotspot = ctx.createRadialGradient(cursorX, cursorY, 0, cursorX, cursorY, 80);
    hotspot.addColorStop(0, "rgba(141, 195, 166, 0.16)");
    hotspot.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = hotspot;
    ctx.fillRect(0, 0, cursorFxWidth, cursorFxHeight);
  }

  function drawCursorStardust(ctx, x, y, dt) {
    if (!stardust.length) {
      seedStardust();
    }
    ctx.globalCompositeOperation = "lighter";
    stardust.forEach((star) => {
      const dx = x - star.x;
      const dy = y - star.y;
      const dist = Math.max(Math.hypot(dx, dy), 1);
      const force = Math.min(120 / dist, 0.85);
      star.vx += (dx / dist) * force * 0.22 * dt;
      star.vy += (dy / dist) * force * 0.22 * dt;
      star.vx *= Math.pow(0.9, dt);
      star.vy *= Math.pow(0.9, dt);
      star.x += star.vx * dt;
      star.y += star.vy * dt;

      if (star.x < -8) star.x = cursorFxWidth + 8;
      if (star.x > cursorFxWidth + 8) star.x = -8;
      if (star.y < -8) star.y = cursorFxHeight + 8;
      if (star.y > cursorFxHeight + 8) star.y = -8;

      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${star.hue.join(",")}, 0.8)`;
      ctx.fill();
    });

    const glow = ctx.createRadialGradient(x, y, 0, x, y, 120);
    glow.addColorStop(0, "rgba(141, 195, 166, 0.16)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, cursorFxWidth, cursorFxHeight);
  }

  function drawCursorConstellation(ctx, x, y, dt) {
    if (!nodes.length) {
      seedNodes();
    }
    const linkDist = 130;
    const cursorDist = 200;

    nodes.forEach((node) => {
      const dx = x - node.x;
      const dy = y - node.y;
      const dist = Math.hypot(dx, dy);
      if (dist < cursorDist && dist > 1) {
        const pull = (1 - dist / cursorDist) * 0.06;
        node.vx += (dx / dist) * pull * dt;
        node.vy += (dy / dist) * pull * dt;
      }
      node.vx = Math.max(Math.min(node.vx, 1.2), -1.2);
      node.vy = Math.max(Math.min(node.vy, 1.2), -1.2);
      node.x += node.vx * dt;
      node.y += node.vy * dt;

      if (node.x < 0 || node.x > cursorFxWidth) node.vx *= -1;
      if (node.y < 0 || node.y > cursorFxHeight) node.vy *= -1;
      node.x = Math.max(0, Math.min(cursorFxWidth, node.x));
      node.y = Math.max(0, Math.min(cursorFxHeight, node.y));
    });

    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist < linkDist) {
          const alpha = (1 - dist / linkDist) * 0.28;
          ctx.strokeStyle = `rgba(141, 195, 166, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }

    nodes.forEach((node) => {
      const dx = x - node.x;
      const dy = y - node.y;
      const dist = Math.hypot(dx, dy);
      if (dist < cursorDist) {
        const alpha = (1 - dist / cursorDist) * 0.5;
        ctx.strokeStyle = `rgba(190, 230, 255, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(node.x, node.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(141, 195, 166, 0.85)";
      ctx.fill();
    });
  }

  function drawCursorBeam(ctx, x, y) {
    const speed = Math.hypot(velX, velY);
    if (speed > 0.6) {
      const target = Math.atan2(velY, velX);
      let diff = target - beamAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      beamAngle += diff * 0.2;
    }

    ctx.globalCompositeOperation = "lighter";
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(beamAngle);

    const beam = ctx.createLinearGradient(-320, 0, 60, 0);
    beam.addColorStop(0, "rgba(0, 0, 0, 0)");
    beam.addColorStop(0.55, "rgba(107, 159, 212, 0.05)");
    beam.addColorStop(0.85, "rgba(141, 195, 166, 0.2)");
    beam.addColorStop(1, "rgba(190, 230, 255, 0.32)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-320, -44);
    ctx.lineTo(-320, 44);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const core = ctx.createRadialGradient(x, y, 0, x, y, 70);
    core.addColorStop(0, "rgba(248, 250, 252, 0.28)");
    core.addColorStop(0.4, "rgba(141, 195, 166, 0.18)");
    core.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, cursorFxWidth, cursorFxHeight);
  }

  function drawCursorFxFrame(now) {
    if (!cursorFxCtx) {
      return;
    }
    cursorFxRafId = window.requestAnimationFrame(drawCursorFxFrame);

    const delta = lastFrameTime ? (now - lastFrameTime) / 16.67 : 1;
    const dt = Math.min(Math.max(delta, 0.2), 3);
    lastFrameTime = now;

    cursorX += (targetCursorX - cursorX) * 0.18;
    cursorY += (targetCursorY - cursorY) * 0.18;
    velX = cursorX - prevCursorX;
    velY = cursorY - prevCursorY;
    prevCursorX = cursorX;
    prevCursorY = cursorY;

    trail.push({ x: cursorX, y: cursorY });
    if (trail.length > TRAIL_MAX) {
      trail.shift();
    }

    cursorFxCtx.clearRect(0, 0, cursorFxWidth, cursorFxHeight);

    if (cursorFxMode === "off") {
      return;
    }

    if (cursorFxMode === "glow") {
      drawCursorGlow(cursorFxCtx, cursorX, cursorY);
    } else if (cursorFxMode === "ribbon") {
      drawCursorRibbon(cursorFxCtx);
    } else if (cursorFxMode === "dots") {
      drawCursorDots(cursorFxCtx);
    } else if (cursorFxMode === "comet") {
      drawCursorComet(cursorFxCtx, dt);
    } else if (cursorFxMode === "aurora") {
      drawCursorAurora(cursorFxCtx);
    } else if (cursorFxMode === "ripple") {
      drawCursorRipples(cursorFxCtx, dt);
    } else if (cursorFxMode === "stardust") {
      drawCursorStardust(cursorFxCtx, cursorX, cursorY, dt);
    } else if (cursorFxMode === "constellation") {
      drawCursorConstellation(cursorFxCtx, cursorX, cursorY, dt);
    } else if (cursorFxMode === "beam") {
      drawCursorBeam(cursorFxCtx, cursorX, cursorY);
    }
  }

  function initCursorFxPicker() {
    const picker = document.createElement("div");
    picker.className = "cursor-fx-picker";
    picker.innerHTML = `
      <div class="cursor-fx-menu" role="menu" aria-label="Background cursor effects">
        ${CURSOR_FX_MODES.map(
          (mode) => `
            <button
              type="button"
              class="cursor-fx-option${mode.id === cursorFxMode ? " is-active" : ""}"
              data-cursor-fx="${mode.id}"
              role="menuitemradio"
              aria-checked="${mode.id === cursorFxMode}"
            >
              <span class="cursor-fx-swatch cursor-fx-swatch-${mode.id}" aria-hidden="true"></span>
              <span>${mode.label}</span>
            </button>
          `
        ).join("")}
      </div>
      <button type="button" class="cursor-fx-toggle" aria-expanded="false" aria-controls="cursor-fx-menu">
        Cursor FX
      </button>
    `;

    const toggle = picker.querySelector(".cursor-fx-toggle");
    const menu = picker.querySelector(".cursor-fx-menu");
    menu.id = "cursor-fx-menu";

    toggle.addEventListener("click", () => {
      const isOpen = picker.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    picker.querySelectorAll("[data-cursor-fx]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.cursorFx;
        applyCursorFxMode(mode);
        picker.querySelectorAll("[data-cursor-fx]").forEach((option) => {
          const active = option.dataset.cursorFx === mode;
          option.classList.toggle("is-active", active);
          option.setAttribute("aria-checked", String(active));
        });
        picker.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });

    document.addEventListener("click", (event) => {
      if (!picker.contains(event.target)) {
        picker.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });

    document.body.appendChild(picker);
  }

  function initCursorFx() {
    if (!bg || isTouch || prefersReducedMotion) {
      return;
    }

    cursorFxMode = readCursorFxMode();
    applyCursorFxMode(cursorFxMode);

    cursorFxCanvas = document.createElement("canvas");
    cursorFxCanvas.id = "cursor-fx-canvas";
    cursorFxCanvas.setAttribute("aria-hidden", "true");
    bg.appendChild(cursorFxCanvas);
    cursorFxCtx = cursorFxCanvas.getContext("2d");
    if (!cursorFxCtx) {
      return;
    }

    resizeCursorFxCanvas();
    window.addEventListener("resize", resizeCursorFxCanvas);
    initCursorFxPicker();
    lastFrameTime = performance.now();
    drawCursorFxFrame(lastFrameTime);
  }

  updateScrollVars();
  window.addEventListener("scroll", updateScrollVars, { passive: true });
  window.addEventListener("resize", updateScrollVars);

  if (!isTouch && !prefersReducedMotion) {
    window.addEventListener("pointermove", updatePointerVars, { passive: true });
    tickPointer();
  } else {
    document.body.classList.add("is-static");
  }

  initMeshCanvas();
  initRevealObserver();
  initScrollCue();
  initCursorFx();

  document.body.classList.add("effects-ready");

  window.addEventListener(
    "beforeunload",
    () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (cursorFxRafId) {
        window.cancelAnimationFrame(cursorFxRafId);
      }
    },
    { once: true }
  );
})();
