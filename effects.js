(function initAmbientEffects() {
  const html = document.documentElement;
  const bg = document.querySelector("#ambient-bg");
  const canvas = document.querySelector("#ambient-canvas");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

  let scrollMax = 1;
  let pointerX = 0;
  let pointerY = 0;
  let targetX = 0;
  let targetY = 0;
  let rafId = 0;

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

  function initTiltCards() {
    if (isTouch || prefersReducedMotion) {
      return;
    }

    document.querySelectorAll("[data-tilt]").forEach((card) => {
      card.addEventListener("pointermove", (event) => {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        const tiltScale = card.dataset.tilt === "half" ? 0.5 : 1;
        card.style.setProperty("--tilt-x", `${(-y * 7 * tiltScale).toFixed(2)}deg`);
        card.style.setProperty("--tilt-y", `${(x * 9 * tiltScale).toFixed(2)}deg`);
      });

      card.addEventListener("pointerleave", () => {
        card.style.setProperty("--tilt-x", "0deg");
        card.style.setProperty("--tilt-y", "0deg");
      });
    });
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
  initTiltCards();

  document.body.classList.add("effects-ready");

  window.addEventListener(
    "beforeunload",
    () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    },
    { once: true }
  );
})();
