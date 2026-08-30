/*
 * Claudia Atlas Canvas renderer.
 * Anatomical layout and rendering concepts are inspired by Brain Atlas (MIT).
 * See ../THIRD_PARTY_NOTICES.md for attribution and license details.
 */
(function installClaudiaAtlas(global) {
  'use strict';

  const TAU = Math.PI * 2;
  const MOBILE_QUERY = '(max-width: 760px), (pointer: coarse)';
  const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
  const DEFAULT_VIEW = Object.freeze({ yaw: -0.28, pitch: 0.08, zoom: 1 });
  const PALETTE = Object.freeze([
    '#8b7cff', '#42d9c8', '#ff76b7', '#ffb45e', '#64a8ff', '#b98cff', '#65df8d', '#ef718c',
  ]);
  const KIND_COLORS = Object.freeze({
    memory: '#8b7cff', document: '#8b7cff', concept: '#42d9c8', person: '#ff76b7',
    project: '#ffb45e', reference: '#64a8ff', brain: '#d7ccff', dream: '#b98cff',
  });

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const now = () => global.performance?.now?.() ?? Date.now();
  const safeCall = (callback, ...args) => {
    if (typeof callback !== 'function') return;
    try { callback(...args); } catch (_) { /* Consumer callbacks must not break rendering. */ }
  };
  const hash = (value) => {
    let result = 2166136261;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index += 1) {
      result ^= text.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  };
  const mulberry32 = (seed) => () => {
    let next = seed += 0x6d2b79f5;
    next = Math.imul(next ^ next >>> 15, next | 1);
    next ^= next + Math.imul(next ^ next >>> 7, next | 61);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
  const escapeLabel = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const isCanvasLike = (canvas) => Boolean(canvas && typeof canvas.getContext === 'function');

  function parseHexColor(value) {
    const text = String(value || '').trim();
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
    if (!match) return null;
    let digits = match[1];
    if (digits.length === 3) digits = digits.split('').map((character) => character + character).join('');
    return {
      color: `#${digits.slice(0, 6).toLowerCase()}`,
      rgb: [
        Number.parseInt(digits.slice(0, 2), 16),
        Number.parseInt(digits.slice(2, 4), 16),
        Number.parseInt(digits.slice(4, 6), 16),
      ],
    };
  }

  function normalizeColor(value, fallback) {
    return parseHexColor(value) || parseHexColor(fallback) || parseHexColor(PALETTE[0]);
  }

  function rgba(color, alpha) {
    const rgb = color?.rgb || [139, 124, 255];
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1)})`;
  }

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function makeSurfacePoints() {
    const random = mulberry32(0xc1a0d1a);
    const points = [];
    for (let index = 0; index < 300; index += 1) {
      const theta = random() * TAU;
      const latitude = Math.asin(random() * 2 - 1);
      const shell = 0.78 + random() * 0.22;
      const side = Math.cos(theta) < 0 ? -1 : 1;
      const x = Math.cos(latitude) * Math.cos(theta) * shell * 1.03;
      const y = Math.sin(latitude) * shell * 0.78;
      const z = Math.cos(latitude) * Math.sin(theta) * shell * 0.68;
      points.push({
        x: x + side * 0.035,
        y: y + Math.max(0, Math.abs(x) - 0.62) * 0.08,
        z,
        size: 0.45 + random() * 1.35,
        alpha: 0.1 + random() * 0.28,
        tone: Math.floor(random() * 4),
      });
    }
    return points;
  }

  const SURFACE_POINTS = makeSurfacePoints();
  const LOBES = Object.freeze([
    { x: -0.56, y: -0.26, z: 0.02, radius: 0.42, color: '#8b7cff' },
    { x: 0.56, y: -0.25, z: 0.02, radius: 0.42, color: '#42d9c8' },
    { x: -0.5, y: 0.3, z: 0.08, radius: 0.36, color: '#ff76b7' },
    { x: 0.5, y: 0.31, z: 0.08, radius: 0.36, color: '#64a8ff' },
    { x: 0, y: 0.42, z: -0.35, radius: 0.31, color: '#ffb45e' },
  ]);

  function ClaudiaAtlasRenderer(canvas, options) {
    if (!(this instanceof ClaudiaAtlasRenderer)) return new ClaudiaAtlasRenderer(canvas, options);
    const documentObject = global.document;
    this.canvas = typeof canvas === 'string' && documentObject ? documentObject.querySelector(canvas) : canvas;
    this.options = options && typeof options === 'object' ? options : {};
    this.context = null;
    this.nodes = [];
    this.edges = [];
    this.regions = [];
    this._nodeById = new Map();
    this._projected = [];
    this._view = { ...DEFAULT_VIEW };
    this._selectedId = null;
    this._hoveredId = null;
    this._search = '';
    this._regionFilter = new Set();
    this._hasRegionFilter = false;
    this._labels = this.options.labels !== false;
    this._active = this.options.active !== false;
    this._motion = this.options.motion !== false;
    this._paused = false;
    this._intersecting = true;
    this._documentVisible = !documentObject?.hidden;
    this._mobile = false;
    this._reducedMotion = false;
    this._destroyed = false;
    this._frame = 0;
    this._lastFrame = 0;
    this._lastInteraction = now();
    this._size = { width: 0, height: 0, dpr: 1, scale: 1 };
    this._drag = null;
    this._listeners = [];
    this._resizeObserver = null;
    this._intersectionObserver = null;
    this._mediaListeners = [];
    this._originalCanvasState = null;

    if (isCanvasLike(this.canvas)) {
      try { this.context = this.canvas.getContext('2d', { alpha: true, desynchronized: true }); }
      catch (_) { this.context = null; }
    }

    this._initialize();
    if (this.options.data) this.setData(this.options.data);
    else this._requestDraw();
  }

  ClaudiaAtlasRenderer.prototype._listen = function _listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    this._listeners.push(() => target.removeEventListener(type, handler, options));
  };

  ClaudiaAtlasRenderer.prototype._initialize = function _initialize() {
    if (!this.canvas || !this.context) return;
    const documentObject = global.document;
    this._originalCanvasState = {
      tabIndex: this.canvas.getAttribute?.('tabindex'),
      role: this.canvas.getAttribute?.('role'),
      ariaLabel: this.canvas.getAttribute?.('aria-label'),
      ariaKeyShortcuts: this.canvas.getAttribute?.('aria-keyshortcuts'),
      touchAction: this.canvas.style?.touchAction,
      cursor: this.canvas.style?.cursor,
    };
    if (!this.canvas.hasAttribute?.('tabindex')) this.canvas.tabIndex = 0;
    if (!this.canvas.hasAttribute?.('role')) this.canvas.setAttribute?.('role', 'application');
    if (!this.canvas.hasAttribute?.('aria-label')) {
      this.canvas.setAttribute?.('aria-label', 'Interactive three-dimensional brain atlas');
    }
    this.canvas.setAttribute?.('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown + - R Space [ ]');
    if (this.canvas.style) {
      this.canvas.style.touchAction = 'none';
      this.canvas.style.cursor = 'grab';
    }

    this._mobileMedia = global.matchMedia?.(MOBILE_QUERY) || null;
    this._reducedMedia = global.matchMedia?.(REDUCED_QUERY) || null;
    const updateMedia = () => {
      this._mobile = Boolean(this._mobileMedia?.matches || this._size.width && this._size.width <= 760);
      this._reducedMotion = Boolean(this._reducedMedia?.matches);
      this._resize(true);
      this._syncLoop();
    };
    for (const media of [this._mobileMedia, this._reducedMedia]) {
      if (!media) continue;
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', updateMedia);
        this._mediaListeners.push(() => media.removeEventListener('change', updateMedia));
      } else if (typeof media.addListener === 'function') {
        media.addListener(updateMedia);
        this._mediaListeners.push(() => media.removeListener(updateMedia));
      }
    }
    updateMedia();

    if (typeof global.ResizeObserver === 'function') {
      this._resizeObserver = new global.ResizeObserver(() => this._resize());
      this._resizeObserver.observe(this.canvas);
    } else {
      this._listen(global, 'resize', () => this._resize(), { passive: true });
    }

    if (typeof global.IntersectionObserver === 'function') {
      this._intersectionObserver = new global.IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        this._intersecting = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
        this._syncLoop();
      }, { threshold: [0, 0.01] });
      this._intersectionObserver.observe(this.canvas);
    }

    this._listen(documentObject, 'visibilitychange', () => {
      this._documentVisible = !documentObject.hidden;
      this._syncLoop();
    });
    this._listen(this.canvas, 'pointerdown', (event) => this._onPointerDown(event));
    this._listen(this.canvas, 'pointermove', (event) => this._onPointerMove(event));
    this._listen(this.canvas, 'pointerup', (event) => this._onPointerUp(event));
    this._listen(this.canvas, 'pointercancel', (event) => this._onPointerCancel(event));
    this._listen(this.canvas, 'pointerleave', (event) => this._onPointerLeave(event));
    this._listen(this.canvas, 'wheel', (event) => this._onWheel(event), { passive: false });
    this._listen(this.canvas, 'keydown', (event) => this._onKeyDown(event));
    this._resize(true);
  };

  ClaudiaAtlasRenderer.prototype._resize = function _resize(force) {
    if (!this.canvas || !this.context || this._destroyed) return;
    const bounds = this.canvas.getBoundingClientRect?.();
    const width = Math.max(0, Math.round(bounds?.width || this.canvas.clientWidth || 0));
    const height = Math.max(0, Math.round(bounds?.height || this.canvas.clientHeight || 0));
    const mobile = Boolean(this._mobileMedia?.matches || width && width <= 760);
    const dpr = Math.min(finite(global.devicePixelRatio, 1), mobile ? 1 : 2);
    if (!force && width === this._size.width && height === this._size.height && dpr === this._size.dpr) return;
    this._mobile = mobile;
    this._size = {
      width,
      height,
      dpr,
      scale: Math.max(1, Math.min(width * 0.39, height * 0.43)),
    };
    if (width > 0 && height > 0) {
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
      if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._requestDraw();
  };

  ClaudiaAtlasRenderer.prototype._canDraw = function _canDraw() {
    return Boolean(!this._destroyed && this.context && this._active && this._intersecting &&
      this._documentVisible && this._size.width > 0 && this._size.height > 0);
  };

  ClaudiaAtlasRenderer.prototype._shouldAnimate = function _shouldAnimate() {
    return this._canDraw() && this._motion && !this._paused && !this._reducedMotion;
  };

  ClaudiaAtlasRenderer.prototype._cancelFrame = function _cancelFrame() {
    if (!this._frame) return;
    if (typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(this._frame);
    else global.clearTimeout?.(this._frame);
    this._frame = 0;
  };

  ClaudiaAtlasRenderer.prototype._requestDraw = function _requestDraw() {
    if (!this._canDraw() || this._frame) return;
    const callback = (timestamp) => this._tick(timestamp);
    this._frame = typeof global.requestAnimationFrame === 'function'
      ? global.requestAnimationFrame(callback)
      : global.setTimeout?.(() => callback(now()), 16);
  };

  ClaudiaAtlasRenderer.prototype._syncLoop = function _syncLoop() {
    if (!this._canDraw()) {
      this._cancelFrame();
      return;
    }
    this._requestDraw();
  };

  ClaudiaAtlasRenderer.prototype._tick = function _tick(timestamp) {
    this._frame = 0;
    if (!this._canDraw()) return;
    const time = finite(timestamp, now());
    const isLooping = this._shouldAnimate();
    const frameInterval = this._mobile ? 1000 / 15 : 1000 / 60;
    if (!isLooping || !this._lastFrame || time - this._lastFrame >= frameInterval - 1) {
      if (isLooping && time - this._lastInteraction > 2000) {
        const elapsed = this._lastFrame ? Math.min(80, time - this._lastFrame) : 0;
        this._view.yaw += elapsed * 0.000045;
      }
      this._draw(this._reducedMotion ? 0 : time);
      this._lastFrame = time;
    }
    if (isLooping) this._requestDraw();
  };

  ClaudiaAtlasRenderer.prototype._normalizeData = function _normalizeData(payload) {
    const inputNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const inputRegions = Array.isArray(payload?.regions) ? payload.regions : [];
    const regions = inputRegions.map((region, index) => {
      const source = region && typeof region === 'object' ? region : { id: region, title: region };
      const id = escapeLabel(source.id ?? source.name ?? source.title ?? `region-${index}`);
      return {
        id,
        title: escapeLabel(source.title ?? source.name ?? id),
        color: normalizeColor(source.color, PALETTE[index % PALETTE.length]),
      };
    }).filter((region) => region.id);
    const regionById = new Map(regions.map((region) => [region.id.toLowerCase(), region]));
    const rawNodes = [];

    for (let index = 0; index < inputNodes.length; index += 1) {
      const source = inputNodes[index];
      if (!source || typeof source !== 'object') continue;
      const id = escapeLabel(source.id ?? `node-${index}`);
      if (!id || rawNodes.some((node) => node.id === id)) continue;
      const kind = escapeLabel(source.kind ?? source.group ?? 'concept').toLowerCase() || 'concept';
      const region = escapeLabel(source.region ?? 'Unmapped') || 'Unmapped';
      let regionInfo = regionById.get(region.toLowerCase());
      if (!regionInfo) {
        regionInfo = {
          id: region,
          title: region,
          color: normalizeColor(null, PALETTE[hash(region) % PALETTE.length]),
        };
        regionById.set(region.toLowerCase(), regionInfo);
        regions.push(regionInfo);
      }
      const fallbackColor = KIND_COLORS[kind] || regionInfo.color.color;
      const seeded = mulberry32(hash(id));
      const hasPosition = source.position && ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(source.position[axis])));
      const generated = {
        x: (seeded() * 2 - 1) * 0.9,
        y: (seeded() * 2 - 1) * 0.68,
        z: (seeded() * 2 - 1) * 0.58,
      };
      rawNodes.push({
        id,
        title: escapeLabel(source.title ?? source.label ?? id) || id,
        kind,
        region,
        color: normalizeColor(source.color, fallbackColor),
        degree: Math.max(0, finite(source.degree, 0)),
        hub: Boolean(source.hub),
        rawPosition: hasPosition ? {
          x: finite(source.position.x), y: finite(source.position.y), z: finite(source.position.z),
        } : generated,
        generated: !hasPosition,
        source,
      });
    }

    const positioned = rawNodes.filter((node) => !node.generated);
    if (positioned.length) {
      const axes = ['x', 'y', 'z'];
      const minimum = { x: Infinity, y: Infinity, z: Infinity };
      const maximum = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const node of positioned) {
        for (const axis of axes) {
          minimum[axis] = Math.min(minimum[axis], node.rawPosition[axis]);
          maximum[axis] = Math.max(maximum[axis], node.rawPosition[axis]);
        }
      }
      const center = Object.fromEntries(axes.map((axis) => [axis, (minimum[axis] + maximum[axis]) / 2]));
      const span = Math.max(1e-6, ...axes.map((axis) => maximum[axis] - minimum[axis]));
      for (const node of positioned) {
        node.position = {
          x: (node.rawPosition.x - center.x) / span * 1.78,
          y: -(node.rawPosition.y - center.y) / span * 1.78,
          z: (node.rawPosition.z - center.z) / span * 1.78,
        };
      }
    }
    for (const node of rawNodes) node.position ||= node.rawPosition;

    const nodeById = new Map(rawNodes.map((node) => [node.id, node]));
    const inputEdges = Array.isArray(payload?.edges) ? payload.edges : Array.isArray(payload?.links) ? payload.links : [];
    const edges = [];
    for (let index = 0; index < inputEdges.length; index += 1) {
      const source = inputEdges[index];
      if (!source || typeof source !== 'object') continue;
      const sourceId = escapeLabel(typeof source.source === 'object' ? source.source?.id : source.source);
      const targetId = escapeLabel(typeof source.target === 'object' ? source.target?.id : source.target);
      if (!nodeById.has(sourceId) || !nodeById.has(targetId) || sourceId === targetId) continue;
      edges.push({
        id: escapeLabel(source.id ?? `${sourceId}:${targetId}:${index}`),
        source: sourceId,
        target: targetId,
        strength: clamp(finite(source.strength ?? source.weight, 1), 0.1, 4),
        phase: (hash(`${sourceId}:${targetId}`) % 1000) / 1000,
        curve: ((hash(`${targetId}:${sourceId}`) % 2001) / 1000 - 1) * 0.18,
      });
    }
    return { regions, nodes: rawNodes, edges, nodeById };
  };

  ClaudiaAtlasRenderer.prototype.setData = function setData(payload) {
    const normalized = this._normalizeData(payload && typeof payload === 'object' ? payload : {});
    this.regions = normalized.regions;
    this.nodes = normalized.nodes;
    this.edges = normalized.edges;
    this._nodeById = normalized.nodeById;
    if (this._selectedId && !this._nodeById.has(this._selectedId)) this._selectedId = null;
    if (this._hoveredId && !this._nodeById.has(this._hoveredId)) this._hoveredId = null;
    this._requestDraw();
    safeCall(this.options.onData, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype._project = function _project(point) {
    const yaw = this._view.yaw;
    const pitch = this._view.pitch;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const rotatedX = point.x * cosYaw - point.z * sinYaw;
    const yawDepth = point.x * sinYaw + point.z * cosYaw;
    const rotatedY = point.y * cosPitch - yawDepth * sinPitch;
    const depth = point.y * sinPitch + yawDepth * cosPitch;
    const perspective = clamp(3.4 / (3.4 + depth), 0.58, 1.65);
    const scale = this._size.scale * this._view.zoom * perspective;
    return {
      x: this._size.width / 2 + rotatedX * scale,
      y: this._size.height / 2 + rotatedY * scale,
      z: depth,
      perspective,
      scale,
    };
  };

  ClaudiaAtlasRenderer.prototype._brainPath = function _brainPath(context) {
    const cx = this._size.width / 2;
    const cy = this._size.height / 2;
    const scale = this._size.scale * this._view.zoom;
    const rx = scale * (1.08 - Math.abs(Math.sin(this._view.yaw)) * 0.09);
    const ry = scale * 0.81;
    context.beginPath();
    context.moveTo(cx - rx * 0.98, cy + ry * 0.08);
    context.bezierCurveTo(cx - rx * 1.04, cy - ry * 0.34, cx - rx * 0.78, cy - ry * 0.79, cx - rx * 0.38, cy - ry * 0.86);
    context.bezierCurveTo(cx - rx * 0.14, cy - ry * 1.04, cx + rx * 0.16, cy - ry * 0.97, cx + rx * 0.36, cy - ry * 0.86);
    context.bezierCurveTo(cx + rx * 0.75, cy - ry * 0.84, cx + rx * 1.03, cy - ry * 0.55, cx + rx * 0.99, cy - ry * 0.16);
    context.bezierCurveTo(cx + rx * 1.08, cy + ry * 0.13, cx + rx * 0.91, cy + ry * 0.48, cx + rx * 0.66, cy + ry * 0.62);
    context.bezierCurveTo(cx + rx * 0.55, cy + ry * 0.87, cx + rx * 0.21, cy + ry * 0.95, cx - rx * 0.04, cy + ry * 0.79);
    context.bezierCurveTo(cx - rx * 0.31, cy + ry * 0.96, cx - rx * 0.61, cy + ry * 0.77, cx - rx * 0.68, cy + ry * 0.55);
    context.bezierCurveTo(cx - rx * 0.92, cy + ry * 0.46, cx - rx * 1.04, cy + ry * 0.27, cx - rx * 0.98, cy + ry * 0.08);
    context.closePath();
    return { cx, cy, rx, ry };
  };

  ClaudiaAtlasRenderer.prototype._drawAnatomy = function _drawAnatomy(context) {
    const { width, height } = this._size;
    const { cx, cy, rx, ry } = this._brainPath(context);
    const aura = context.createRadialGradient(cx, cy, rx * 0.04, cx, cy, rx * 1.22);
    aura.addColorStop(0, 'rgba(95, 67, 192, 0.14)');
    aura.addColorStop(0.58, 'rgba(58, 217, 200, 0.05)');
    aura.addColorStop(1, 'rgba(22, 18, 55, 0)');
    context.fillStyle = aura;
    context.fillRect(0, 0, width, height);

    this._brainPath(context);
    const tissue = context.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
    tissue.addColorStop(0, 'rgba(102, 77, 190, 0.10)');
    tissue.addColorStop(0.5, 'rgba(58, 46, 115, 0.065)');
    tissue.addColorStop(1, 'rgba(23, 190, 184, 0.085)');
    context.fillStyle = tissue;
    context.fill();
    context.strokeStyle = 'rgba(190, 181, 255, 0.17)';
    context.lineWidth = 1.15;
    context.stroke();

    context.save();
    this._brainPath(context);
    context.clip();
    for (const lobe of LOBES) {
      const projected = this._project(lobe);
      const radius = Math.max(12, lobe.radius * projected.scale);
      const color = normalizeColor(lobe.color, PALETTE[0]);
      const glow = context.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, radius);
      glow.addColorStop(0, rgba(color, 0.13));
      glow.addColorStop(0.5, rgba(color, 0.045));
      glow.addColorStop(1, rgba(color, 0));
      context.fillStyle = glow;
      context.fillRect(projected.x - radius, projected.y - radius, radius * 2, radius * 2);
    }

    const foldCount = this._mobile ? 11 : 18;
    for (let index = 0; index < foldCount; index += 1) {
      const seed = mulberry32(0xbca1 + index * 37);
      const side = index % 2 ? 1 : -1;
      const startX = cx + side * rx * (0.12 + seed() * 0.62);
      const startY = cy - ry * 0.67 + seed() * ry * 1.24;
      const length = rx * (0.13 + seed() * 0.19);
      context.beginPath();
      context.moveTo(startX, startY);
      context.bezierCurveTo(
        startX + side * length * 0.25, startY - ry * (0.1 + seed() * 0.08),
        startX + side * length * 0.8, startY + ry * (seed() * 0.2 - 0.1),
        startX + side * length, startY + ry * (seed() * 0.18 - 0.09),
      );
      context.strokeStyle = index % 3 === 0 ? 'rgba(111, 225, 213, 0.10)' : 'rgba(181, 163, 255, 0.105)';
      context.lineWidth = 0.7;
      context.stroke();
    }

    const points = this._mobile ? SURFACE_POINTS.slice(0, 165) : SURFACE_POINTS;
    const tones = ['#9d8cff', '#53d4ca', '#d28eff', '#739dff'];
    for (const point of points) {
      const projected = this._project(point);
      if (projected.z > 0.7) continue;
      context.beginPath();
      context.arc(projected.x, projected.y, point.size * projected.perspective, 0, TAU);
      context.fillStyle = rgba(normalizeColor(tones[point.tone], tones[0]), point.alpha * clamp(1.15 - projected.z * 0.25, 0.4, 1.2));
      context.fill();
    }
    context.restore();

    const split = Math.sin(this._view.yaw) * rx * 0.11;
    context.beginPath();
    context.moveTo(cx + split, cy - ry * 0.88);
    context.bezierCurveTo(cx - split * 0.2, cy - ry * 0.42, cx + split * 0.3, cy + ry * 0.23, cx - split * 0.45, cy + ry * 0.77);
    context.strokeStyle = 'rgba(219, 211, 255, 0.13)';
    context.lineWidth = 0.85;
    context.stroke();
  };

  ClaudiaAtlasRenderer.prototype._matchesRegion = function _matchesRegion(node) {
    if (!this._hasRegionFilter) return true;
    return this._regionFilter.has(node.region.toLowerCase());
  };

  ClaudiaAtlasRenderer.prototype._matchesSearch = function _matchesSearch(node) {
    if (!this._search) return true;
    return `${node.title}\n${node.id}\n${node.kind}\n${node.region}`.toLowerCase().includes(this._search);
  };

  ClaudiaAtlasRenderer.prototype._nodeOpacity = function _nodeOpacity(node) {
    let opacity = this._matchesRegion(node) ? 1 : 0.09;
    if (!this._matchesSearch(node)) opacity *= 0.15;
    return opacity;
  };

  ClaudiaAtlasRenderer.prototype._edgeCurve = function _edgeCurve(edge, source, target) {
    const middleX = (source.x + target.x) / 2;
    const middleY = (source.y + target.y) / 2;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    return {
      x: middleX - dy / distance * distance * edge.curve,
      y: middleY + dx / distance * distance * edge.curve,
    };
  };

  ClaudiaAtlasRenderer.prototype._drawEdges = function _drawEdges(context, projectedById, timestamp) {
    const selected = this._selectedId;
    const limit = this._mobile ? 360 : 800;
    const edges = this.edges.length > limit
      ? this.edges.filter((edge) => hash(edge.id) % Math.ceil(this.edges.length / limit) === 0).slice(0, limit)
      : this.edges;
    const pulses = [];
    for (const edge of edges) {
      const source = projectedById.get(edge.source);
      const target = projectedById.get(edge.target);
      if (!source || !target) continue;
      const sourceOpacity = this._nodeOpacity(source.node);
      const targetOpacity = this._nodeOpacity(target.node);
      const selectedEdge = selected && (edge.source === selected || edge.target === selected);
      const opacity = Math.min(sourceOpacity, targetOpacity) * (selectedEdge ? 0.54 : 0.105);
      if (opacity < 0.008) continue;
      const control = this._edgeCurve(edge, source, target);
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.quadraticCurveTo(control.x, control.y, target.x, target.y);
      context.strokeStyle = selectedEdge ? 'rgba(211, 202, 255, 0.68)' : `rgba(130, 183, 232, ${opacity})`;
      context.lineWidth = selectedEdge ? 1.35 : clamp(0.48 + edge.strength * 0.16, 0.55, 1.1);
      context.stroke();

      if (this._shouldAnimate() && opacity > 0.04 && hash(edge.id) % 13 === 0 && pulses.length < (this._mobile ? 5 : 11)) {
        const progress = (timestamp * 0.000105 * (0.65 + edge.strength * 0.15) + edge.phase) % 1;
        const inverse = 1 - progress;
        pulses.push({
          x: inverse * inverse * source.x + 2 * inverse * progress * control.x + progress * progress * target.x,
          y: inverse * inverse * source.y + 2 * inverse * progress * control.y + progress * progress * target.y,
          opacity: selectedEdge ? 0.95 : 0.68,
        });
      }
    }
    for (const pulse of pulses) {
      const glow = context.createRadialGradient(pulse.x, pulse.y, 0, pulse.x, pulse.y, 6);
      glow.addColorStop(0, `rgba(220, 252, 255, ${pulse.opacity})`);
      glow.addColorStop(0.35, 'rgba(116, 227, 216, 0.48)');
      glow.addColorStop(1, 'rgba(116, 227, 216, 0)');
      context.fillStyle = glow;
      context.fillRect(pulse.x - 6, pulse.y - 6, 12, 12);
    }
  };

  ClaudiaAtlasRenderer.prototype._drawNode = function _drawNode(context, projected) {
    const node = projected.node;
    const selected = node.id === this._selectedId;
    const hovered = node.id === this._hoveredId;
    const opacity = this._nodeOpacity(node);
    const baseRadius = 2.5 + Math.min(4.2, Math.sqrt(node.degree) * 0.58) + (node.hub ? 1.5 : 0);
    const radius = clamp(baseRadius * projected.perspective, 2, 9) + (selected ? 2.3 : hovered ? 1.1 : 0);
    if (selected || hovered || node.hub && opacity > 0.5) {
      const glowRadius = radius * (selected ? 3.2 : 2.45);
      const glow = context.createRadialGradient(projected.x, projected.y, radius * 0.1, projected.x, projected.y, glowRadius);
      glow.addColorStop(0, rgba(node.color, (selected ? 0.52 : 0.24) * opacity));
      glow.addColorStop(1, rgba(node.color, 0));
      context.fillStyle = glow;
      context.fillRect(projected.x - glowRadius, projected.y - glowRadius, glowRadius * 2, glowRadius * 2);
    }
    context.beginPath();
    context.arc(projected.x, projected.y, radius, 0, TAU);
    context.fillStyle = rgba(node.color, (selected ? 1 : hovered ? 0.96 : 0.78) * opacity);
    context.fill();
    context.lineWidth = selected ? 2 : hovered ? 1.4 : 0.7;
    context.strokeStyle = selected
      ? `rgba(255, 255, 255, ${0.94 * opacity})`
      : `rgba(225, 239, 255, ${(hovered ? 0.72 : 0.28) * opacity})`;
    context.stroke();
    if (opacity > 0.25) {
      context.beginPath();
      context.arc(projected.x - radius * 0.27, projected.y - radius * 0.3, Math.max(0.65, radius * 0.18), 0, TAU);
      context.fillStyle = `rgba(255, 255, 255, ${0.72 * opacity})`;
      context.fill();
    }
    projected.hitRadius = Math.max(9, radius + 5);
    projected.opacity = opacity;
    projected.radius = radius;
  };

  ClaudiaAtlasRenderer.prototype._drawLabels = function _drawLabels(context, projected) {
    const candidates = projected.filter((item) => {
      if (item.node.id === this._selectedId || item.node.id === this._hoveredId) return true;
      return this._labels && item.opacity > 0.45 && item.node.hub;
    }).sort((a, b) => {
      const aPriority = (a.node.id === this._selectedId ? 1000 : a.node.id === this._hoveredId ? 900 : 0) + a.node.degree;
      const bPriority = (b.node.id === this._selectedId ? 1000 : b.node.id === this._hoveredId ? 900 : 0) + b.node.degree;
      return bPriority - aPriority;
    }).slice(0, this._mobile ? 8 : 18);
    const boxes = [];
    context.font = `${this._mobile ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    context.textBaseline = 'middle';
    for (const item of candidates) {
      const selected = item.node.id === this._selectedId;
      const label = item.node.title.length > 34 ? `${item.node.title.slice(0, 32)}…` : item.node.title;
      const textWidth = Math.ceil(context.measureText(label).width);
      const width = textWidth + 14;
      const height = selected ? 24 : 20;
      let x = item.x + item.radius + 7;
      let y = item.y - height / 2;
      if (x + width > this._size.width - 6) x = item.x - item.radius - width - 7;
      y = clamp(y, 5, this._size.height - height - 5);
      const overlaps = boxes.some((box) => x < box.x + box.width + 4 && x + width + 4 > box.x && y < box.y + box.height + 3 && y + height + 3 > box.y);
      if (overlaps && !selected && item.node.id !== this._hoveredId) continue;
      boxes.push({ x, y, width, height });
      roundedRect(context, x, y, width, height, 6);
      context.fillStyle = selected ? 'rgba(26, 22, 55, 0.94)' : 'rgba(16, 18, 38, 0.82)';
      context.fill();
      context.strokeStyle = selected ? rgba(item.node.color, 0.72) : 'rgba(177, 187, 228, 0.18)';
      context.lineWidth = selected ? 1 : 0.7;
      context.stroke();
      context.fillStyle = selected ? 'rgba(249, 247, 255, 0.98)' : 'rgba(226, 229, 248, 0.9)';
      context.fillText(label, x + 7, y + height / 2 + 0.5);
    }
  };

  ClaudiaAtlasRenderer.prototype._drawEmptyState = function _drawEmptyState(context) {
    const cx = this._size.width / 2;
    const cy = this._size.height / 2;
    context.fillStyle = 'rgba(217, 212, 242, 0.62)';
    context.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('AWAITING NEURAL MAP', cx, cy);
    context.textAlign = 'start';
  };

  ClaudiaAtlasRenderer.prototype._draw = function _draw(timestamp) {
    const context = this.context;
    if (!context) return;
    const { width, height, dpr } = this._size;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalCompositeOperation = 'source-over';
    this._drawAnatomy(context);
    if (!this.nodes.length) {
      this._projected = [];
      this._drawEmptyState(context);
      context.restore();
      return;
    }

    const projected = this.nodes.map((node) => ({ ...this._project(node.position), node }));
    projected.sort((a, b) => b.z - a.z);
    const projectedById = new Map(projected.map((item) => [item.node.id, item]));
    this._drawEdges(context, projectedById, timestamp);
    for (const item of projected) this._drawNode(context, item);
    this._drawLabels(context, projected);
    this._projected = projected;
    context.restore();
  };

  ClaudiaAtlasRenderer.prototype._canvasPoint = function _canvasPoint(event) {
    const bounds = this.canvas?.getBoundingClientRect?.();
    return {
      x: finite(event?.clientX) - finite(bounds?.left),
      y: finite(event?.clientY) - finite(bounds?.top),
    };
  };

  ClaudiaAtlasRenderer.prototype._hitTest = function _hitTest(point) {
    let best = null;
    let bestDistance = Infinity;
    for (let index = this._projected.length - 1; index >= 0; index -= 1) {
      const projected = this._projected[index];
      if (projected.opacity < 0.2) continue;
      const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
      if (distance <= (projected.hitRadius || 9) && distance < bestDistance) {
        best = projected.node;
        bestDistance = distance;
      }
    }
    return best;
  };

  ClaudiaAtlasRenderer.prototype._markInteraction = function _markInteraction() {
    this._lastInteraction = now();
  };

  ClaudiaAtlasRenderer.prototype._onPointerDown = function _onPointerDown(event) {
    if (event.isPrimary === false || finite(event.button, 0) !== 0) return;
    const point = this._canvasPoint(event);
    this._drag = {
      id: event.pointerId,
      startX: point.x,
      startY: point.y,
      x: point.x,
      y: point.y,
      yaw: this._view.yaw,
      pitch: this._view.pitch,
      moved: false,
    };
    this._markInteraction();
    this.canvas?.focus?.({ preventScroll: true });
    try { this.canvas?.setPointerCapture?.(event.pointerId); } catch (_) { /* Capture is opportunistic. */ }
    if (this.canvas?.style) this.canvas.style.cursor = 'grabbing';
    event.preventDefault?.();
  };

  ClaudiaAtlasRenderer.prototype._onPointerMove = function _onPointerMove(event) {
    const point = this._canvasPoint(event);
    if (this._drag && this._drag.id === event.pointerId) {
      const dx = point.x - this._drag.startX;
      const dy = point.y - this._drag.startY;
      if (Math.hypot(dx, dy) > 3) this._drag.moved = true;
      this._view.yaw = this._drag.yaw + dx * 0.007;
      this._view.pitch = clamp(this._drag.pitch + dy * 0.006, -0.78, 0.78);
      this._drag.x = point.x;
      this._drag.y = point.y;
      this._markInteraction();
      this._requestDraw();
      event.preventDefault?.();
      return;
    }
    if (event.pointerType === 'touch') return;
    const hit = this._hitTest(point);
    const id = hit?.id || null;
    if (id !== this._hoveredId) {
      this._hoveredId = id;
      if (this.canvas?.style) this.canvas.style.cursor = id ? 'pointer' : 'grab';
      safeCall(this.options.onHover, hit?.id || null, this.getState(), hit || null);
      this._requestDraw();
    }
  };

  ClaudiaAtlasRenderer.prototype._onPointerUp = function _onPointerUp(event) {
    if (!this._drag || this._drag.id !== event.pointerId) return;
    const drag = this._drag;
    this._drag = null;
    try { this.canvas?.releasePointerCapture?.(event.pointerId); } catch (_) { /* Ignore stale capture. */ }
    if (this.canvas?.style) this.canvas.style.cursor = 'grab';
    if (!drag.moved) this.selectNode(this._hitTest(this._canvasPoint(event))?.id || null);
    this._markInteraction();
    this._requestDraw();
    event.preventDefault?.();
  };

  ClaudiaAtlasRenderer.prototype._onPointerCancel = function _onPointerCancel(event) {
    if (this._drag?.id !== event.pointerId) return;
    this._drag = null;
    if (this.canvas?.style) this.canvas.style.cursor = 'grab';
    this._requestDraw();
  };

  ClaudiaAtlasRenderer.prototype._onPointerLeave = function _onPointerLeave(event) {
    if (!this._drag && this._hoveredId) {
      this._hoveredId = null;
      if (this.canvas?.style) this.canvas.style.cursor = 'grab';
      safeCall(this.options.onHover, null, this.getState(), null);
      this._requestDraw();
    }
    if (event.pointerType === 'touch') event.preventDefault?.();
  };

  ClaudiaAtlasRenderer.prototype._onWheel = function _onWheel(event) {
    const delta = clamp(finite(event.deltaY), -120, 120);
    this.zoomBy(-delta * 0.0015);
    this._markInteraction();
    event.preventDefault?.();
  };

  ClaudiaAtlasRenderer.prototype._cycleNode = function _cycleNode(direction) {
    const candidates = this.nodes.filter((node) => this._matchesRegion(node) && this._matchesSearch(node))
      .sort((a, b) => Number(b.hub) - Number(a.hub) || b.degree - a.degree || a.title.localeCompare(b.title));
    if (!candidates.length) return;
    let index = candidates.findIndex((node) => node.id === this._selectedId);
    index = index < 0 ? (direction > 0 ? 0 : candidates.length - 1) : (index + direction + candidates.length) % candidates.length;
    this.selectNode(candidates[index].id);
  };

  ClaudiaAtlasRenderer.prototype._onKeyDown = function _onKeyDown(event) {
    const key = String(event.key || '').toLowerCase();
    let handled = true;
    if (key === 'arrowleft') this._view.yaw -= 0.1;
    else if (key === 'arrowright') this._view.yaw += 0.1;
    else if (key === 'arrowup') this._view.pitch = clamp(this._view.pitch - 0.08, -0.78, 0.78);
    else if (key === 'arrowdown') this._view.pitch = clamp(this._view.pitch + 0.08, -0.78, 0.78);
    else if (key === '+' || key === '=') this.zoomBy(0.12);
    else if (key === '-' || key === '_') this.zoomBy(-0.12);
    else if (key === 'r') this.reset();
    else if (key === ' ' || key === 'spacebar') this.pause(!this._paused);
    else if (key === ']' || key === 'pagedown' || key === 'n') this._cycleNode(1);
    else if (key === '[' || key === 'pageup' || key === 'p') this._cycleNode(-1);
    else if (key === 'escape') this.selectNode(null);
    else handled = false;
    if (!handled) return;
    this._markInteraction();
    this._requestDraw();
    safeCall(this.options.onStateChange, this.getState());
    event.preventDefault?.();
  };

  ClaudiaAtlasRenderer.prototype._updateAriaLabel = function _updateAriaLabel() {
    if (!this.canvas?.setAttribute) return;
    const node = this._nodeById.get(this._selectedId);
    const base = this._originalCanvasState?.ariaLabel || 'Interactive three-dimensional brain atlas';
    this.canvas.setAttribute('aria-label', node ? `${base}. Selected: ${node.title}, ${node.region}` : base);
  };

  ClaudiaAtlasRenderer.prototype.setActive = function setActive(active) {
    this._active = Boolean(active);
    this._syncLoop();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.setMotion = function setMotion(enabled) {
    this._motion = Boolean(enabled);
    if (this._motion) this._paused = false;
    this._markInteraction();
    this._syncLoop();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.pause = function pause(paused = true) {
    this._paused = Boolean(paused);
    this._syncLoop();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.toggleMotion = function toggleMotion() {
    return this.pause(!this._paused);
  };

  ClaudiaAtlasRenderer.prototype.setLabels = function setLabels(enabled) {
    this._labels = Boolean(enabled);
    this._requestDraw();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.setSearch = function setSearch(query) {
    this._search = escapeLabel(query).toLowerCase();
    this._requestDraw();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.setRegion = function setRegion(region, enabled) {
    const values = region instanceof Set ? [...region] : Array.isArray(region) ? region : [region];
    const requestsAll = values.some((value) => {
      const source = typeof value === 'object' ? value?.id ?? value?.name ?? value?.title : value;
      const key = escapeLabel(source).toLowerCase();
      return !key || key === 'all' || key === '*';
    });
    const normalized = values
      .map((value) => typeof value === 'object' ? value?.id ?? value?.name ?? value?.title : value)
      .map((value) => escapeLabel(value).toLowerCase())
      .filter((value) => value && value !== 'all' && value !== '*');
    if (requestsAll) {
      this._regionFilter.clear();
      this._hasRegionFilter = false;
    } else if (typeof enabled === 'boolean') {
      this._hasRegionFilter = true;
      for (const value of normalized) {
        if (enabled) this._regionFilter.add(value);
        else this._regionFilter.delete(value);
      }
    } else {
      this._regionFilter = new Set(normalized);
      this._hasRegionFilter = true;
    }
    this._requestDraw();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.reset = function reset() {
    this._view = { ...DEFAULT_VIEW };
    this._markInteraction();
    this._requestDraw();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.zoomBy = function zoomBy(delta) {
    this._view.zoom = clamp(this._view.zoom + finite(delta, 0), 0.58, 2.7);
    this._markInteraction();
    this._requestDraw();
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.selectNode = function selectNode(id) {
    const key = id == null ? null : String(typeof id === 'object' ? id.id : id);
    const node = key && this._nodeById.has(key) ? this._nodeById.get(key) : null;
    this._selectedId = node?.id || null;
    this._updateAriaLabel();
    this._requestDraw();
    safeCall(this.options.onSelect, node?.id || null, this.getState(), node);
    safeCall(this.options.onStateChange, this.getState());
    return this;
  };

  ClaudiaAtlasRenderer.prototype.render = function render() {
    this._resize();
    this._requestDraw();
    return this;
  };

  ClaudiaAtlasRenderer.prototype.getState = function getState() {
    return {
      active: this._active,
      motion: this._motion,
      paused: this._paused,
      reducedMotion: this._reducedMotion,
      labels: this._labels,
      search: this._search,
      region: this._regionFilter.size === 1 ? [...this._regionFilter][0] : null,
      regions: [...this._regionFilter],
      selectedId: this._selectedId,
      hoveredId: this._hoveredId,
      yaw: this._view.yaw,
      pitch: this._view.pitch,
      zoom: this._view.zoom,
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
      mobile: this._mobile,
      visible: this._documentVisible && this._intersecting,
    };
  };

  ClaudiaAtlasRenderer.prototype.destroy = function destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._cancelFrame();
    this._resizeObserver?.disconnect?.();
    this._intersectionObserver?.disconnect?.();
    for (const remove of this._listeners.splice(0)) remove();
    for (const remove of this._mediaListeners.splice(0)) remove();
    if (this.canvas && this._originalCanvasState) {
      const restoreAttribute = (name, value) => value == null
        ? this.canvas.removeAttribute?.(name)
        : this.canvas.setAttribute?.(name, value);
      restoreAttribute('tabindex', this._originalCanvasState.tabIndex);
      restoreAttribute('role', this._originalCanvasState.role);
      restoreAttribute('aria-label', this._originalCanvasState.ariaLabel);
      restoreAttribute('aria-keyshortcuts', this._originalCanvasState.ariaKeyShortcuts);
      if (this.canvas.style) {
        this.canvas.style.touchAction = this._originalCanvasState.touchAction || '';
        this.canvas.style.cursor = this._originalCanvasState.cursor || '';
      }
    }
    this._projected = [];
    this._nodeById.clear();
    this.context = null;
    this.canvas = null;
  };

  global.ClaudiaAtlasRenderer = ClaudiaAtlasRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
