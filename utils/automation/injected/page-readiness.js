// Fixed read-only probe in an isolated world. Only hashes/geometry leave the page.
function pageReadiness(viewport, point) {
  const root = document.scrollingElement || document.documentElement;
  const scrollState = (e) => ({
    x: e.scrollLeft,
    y: e.scrollTop,
    width: e.scrollWidth,
    height: e.scrollHeight,
    clientWidth: e.clientWidth,
    clientHeight: e.clientHeight,
  });
  let target = document.elementFromPoint(point?.x ?? innerWidth / 2, point?.y ?? innerHeight / 2);
  while (target?.shadowRoot?.elementFromPoint) {
    const child = target.shadowRoot.elementFromPoint(
      point?.x ?? innerWidth / 2,
      point?.y ?? innerHeight / 2,
    );
    if (!child || child === target) break;
    target = child;
  }
  for (; target && target !== root; target = target.parentElement || target.getRootNode().host) {
    const s = getComputedStyle(target);
    if (
      (target.scrollHeight > target.clientHeight && /auto|scroll/.test(s.overflowY)) ||
      (target.scrollWidth > target.clientWidth && /auto|scroll/.test(s.overflowX))
    )
      break;
  }
  const scroll = scrollState(target || root);
  let hash = 2166136261,
    visited = 0,
    limited = false,
    busy = document.readyState === 'loading';
  const add = (text) => {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  };
  const walk = (element, clip) => {
    if (++visited > 2500) {
      limited = true;
      return;
    }
    if (
      /^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
      element.isContentEditable ||
      element.id?.startsWith('coco-') ||
      element.hasAttribute('data-coco-cursor')
    )
      return;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.opacity === '0') return;
    const r = element.getBoundingClientRect();
    const visible =
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > clip.y &&
      r.top < clip.y + clip.height &&
      r.right > clip.x &&
      r.left < clip.x + clip.width;
    if (visible) {
      if (
        element.getAttribute('aria-busy') === 'true' ||
        (element.getAttribute('role') === 'progressbar' && !element.hasAttribute('aria-valuenow'))
      )
        busy = true;
      add(
        element.tagName +
          ':' +
          element.childElementCount +
          ':' +
          Math.round(element.scrollTop) +
          ':' +
          element.scrollHeight +
          ':' +
          element.getAttribute('aria-expanded'),
      );
      for (const node of element.childNodes)
        if (node.nodeType === 3) add((node.textContent || '').slice(0, 800));
    }
    let next = { ...clip };
    if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
      next.y = Math.max(clip.y, r.top);
      next.height = Math.max(0, Math.min(clip.y + clip.height, r.bottom) - next.y);
    }
    if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
      next.x = Math.max(clip.x, r.left);
      next.width = Math.max(0, Math.min(clip.x + clip.width, r.right) - next.x);
    }
    if (!next.height || !next.width) return;
    for (const child of element.children) {
      if (visited > 2500) break;
      walk(child, next);
    }
    if (element.shadowRoot)
      for (const child of element.shadowRoot.children) {
        if (visited > 2500) break;
        walk(child, next);
      }
  };
  walk(document.documentElement, viewport);
  add(JSON.stringify(scrollState(root)) + JSON.stringify(scroll));
  return { signature: String(hash >>> 0), busy, limited, scroll };
}
