// Runs only in our CDP isolated world. All text and markup are bundled, never page/Agent code.
function renderCursor(update, palette, labels) {
  const key = '__cocoVisualCursor';
  let state = globalThis[key];
  if (update.action === 'remove') {
    if (state?.owner === update.owner) {
      state.cancelMovement?.();
      clearTimeout(state.timer);
      state.host.remove();
      delete globalThis[key];
    }
    return;
  }
  if (update.action === 'hide' || update.action === 'restore') {
    if (state?.owner === update.owner) {
      if (update.action === 'hide') state.cancelMovement?.();
      state.host.style.setProperty(
        'visibility',
        update.action === 'hide' ? 'hidden' : 'visible',
        'important',
      );
    }
    return;
  }
  if (!state || state.owner !== update.owner || !state.host.isConnected) {
    if (state) {
      state.cancelMovement?.();
      clearTimeout(state.timer);
      state.host.remove();
    }
    const host = document.createElement('div');
    host.id = 'coco-agent-cursor';
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    for (const [name, value] of Object.entries({
      all: 'initial',
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      'pointer-events': 'none',
      'z-index': '2147483647',
    }))
      host.style.setProperty(name, value, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      ${palette}
      :host,*{pointer-events:none!important;box-sizing:border-box}
      .pointer{position:fixed;left:0;top:0;filter:drop-shadow(0 2px 3px color-mix(in srgb,var(--zylos-neutral-900) 33%,transparent));will-change:transform}
      svg{display:block;width:27px;height:32px;overflow:visible}
      .label{position:absolute;left:22px;top:24px;white-space:nowrap;padding:5px 9px;border-radius:8px;background:var(--zylos-purple-500);color:var(--zylos-neutral-0);font:600 12px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px color-mix(in srgb,var(--zylos-neutral-900) 15%,transparent)}
      .ring{position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px;border:2px solid var(--zylos-purple-500);border-radius:50%;opacity:0;background:color-mix(in srgb,var(--zylos-purple-500) 12%,transparent)}
      .outline{position:fixed;left:0;top:0;border:2px solid var(--zylos-purple-500);border-radius:5px;box-shadow:0 0 0 3px color-mix(in srgb,var(--zylos-purple-500) 13%,transparent);display:none}
      @media(prefers-reduced-motion:reduce){.pointer{transition:none}}
    `);
    shadow.adoptedStyleSheets = [sheet];
    const pointer = document.createElement('div');
    pointer.className = 'pointer';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 27 32');
    const arrow = document.createElementNS(svg.namespaceURI, 'path');
    arrow.setAttribute('d', 'M2 2L23 18L14 19L10 28Z');
    arrow.setAttribute('fill', 'var(--zylos-purple-500)');
    arrow.setAttribute('stroke', 'var(--zylos-neutral-0)');
    arrow.setAttribute('stroke-width', '2');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.append(arrow);
    const label = document.createElement('span');
    label.className = 'label';
    const ring = document.createElement('div');
    ring.className = 'ring';
    const outline = document.createElement('div');
    outline.className = 'outline';
    pointer.append(svg, label);
    shadow.append(outline, ring, pointer);
    document.documentElement.append(host);
    state = { host, pointer, label, ring, outline, owner: update.owner, timer: null };
    state.renew = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.cancelMovement?.();
        state.host.remove();
        if (globalThis[key] === state) delete globalThis[key];
      }, 3000);
    };
    globalThis[key] = state;
  }
  clearTimeout(state.timer);
  // Native trajectory samples must match the dispatched coordinate, including edges.
  const x = update.nativePoint ? update.x : Math.max(2, Math.min(innerWidth - 4, update.x));
  const y = update.nativePoint ? update.y : Math.max(2, Math.min(innerHeight - 4, update.y));
  const previous = state.position;
  const from = previous ? getComputedStyle(state.pointer).transform : null;
  state.cancelMovement?.();
  state.host.dataset.action = update.action;
  state.host.style.setProperty('visibility', 'visible', 'important');
  state.pointer.style.transform = `translate(${x}px,${y}px)`;
  state.position = { x, y };
  state.host.dataset.movement = update.nativePoint && update.moving ? 'moving' : 'arrived';
  let arrival = Promise.resolve({ arrived: true });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const distance = previous ? Math.hypot(x - previous.x, y - previous.y) : 0;
  if (!update.nativePoint && update.waitForArrival && previous && distance > 2 && !reducedMotion) {
    const duration = Math.min(220, Math.max(90, distance * 0.35));
    state.host.dataset.movement = 'moving';
    arrival = new Promise((resolve) => {
      let animation;
      let fallback;
      let settled = false;
      const settle = (arrived) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        animation?.cancel();
        state.cancelMovement = null;
        state.host.dataset.movement = arrived ? 'arrived' : 'cancelled';
        resolve({ arrived });
      };
      state.cancelMovement = () => settle(false);
      // Background tabs may throttle animations. Visual feedback never holds a tool indefinitely.
      fallback = setTimeout(() => settle(false), 400);
      try {
        animation = state.pointer.animate(
          [{ transform: from }, { transform: state.pointer.style.transform }],
          { duration, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' },
        );
        animation.finished.then(
          () => settle(true),
          () => settle(false),
        );
      } catch {
        settle(false);
      }
    });
  }
  state.label.textContent = `Zylos · ${labels[update.action] || labels.working}`;
  state.label.style.left = x > innerWidth - 150 ? '-115px' : '22px';
  state.label.style.top = y > innerHeight - 65 ? '-28px' : '24px';
  state.outline.style.display = update.rect ? 'block' : 'none';
  if (update.rect) {
    const r = update.rect;
    Object.assign(state.outline.style, {
      transform: `translate(${r.x - 3}px,${r.y - 3}px)`,
      width: `${r.width + 6}px`,
      height: `${r.height + 6}px`,
    });
  }
  if (update.action === 'click') {
    state.ring.style.left = `${x}px`;
    state.ring.style.top = `${y}px`;
    for (const a of state.ring.getAnimations()) a.cancel();
    state.ring.animate(
      [
        { transform: 'scale(.35)', opacity: 0.95 },
        { transform: 'scale(1.6)', opacity: 0 },
      ],
      { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 100 : 650 },
    );
  }
  // Self-clean even if Chrome detaches or the worker is killed before cleanup.
  state.renew();
  return arrival;
}
