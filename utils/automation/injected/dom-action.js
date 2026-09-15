// Runs in the element's own execution context, including iframe and shadow roots.
function domAction(action, option) {
  const sensitive = this.matches?.('input[type=password],input[autocomplete=one-time-code]');
  if (action === 'sensitive') return !!sensitive;
  const doc = this.ownerDocument;
  const view = doc.defaultView;
  const active = () => {
    let root = this.getRootNode();
    return root.activeElement === this;
  };
  const hit = (x, y) => {
    let element = this;
    for (;;) {
      const root = element.getRootNode();
      const found = root.elementFromPoint?.(x, y);
      if (!found || !(found === element || element.contains(found))) return false;
      if (!root.host) return true;
      element = root.host;
    }
  };
  const disabled = () =>
    this.matches?.(':disabled') || this.getAttribute('aria-disabled') === 'true';
  const state = () => {
    const r = this.getBoundingClientRect(),
      style = view.getComputedStyle(this);
    const visible =
      !!this.isConnected &&
      r.width > 0 &&
      r.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
    const role = this.getAttribute('role');
    const check = this.getAttribute('aria-checked');
    return {
      attached: this.isConnected,
      tag: this.tagName.toLowerCase(),
      role,
      text: (this.innerText || this.textContent || '').slice(0, 4000),
      value: sensitive
        ? '[redacted]'
        : 'value' in this
          ? String(this.value).slice(0, 4000)
          : undefined,
      checked:
        check !== null
          ? check === 'mixed'
            ? 'mixed'
            : check === 'true'
          : 'checked' in this
            ? this.checked
            : undefined,
      selected:
        this.getAttribute('aria-selected') ?? ('selected' in this ? this.selected : undefined),
      expanded: this.hasAttribute('aria-expanded')
        ? this.getAttribute('aria-expanded') === 'true'
        : undefined,
      clickable: visible && !disabled() && hit(r.x + r.width / 2, r.y + r.height / 2),
      disabled: !!disabled(),
      readOnly: !!this.readOnly,
      visible,
      focused: active(),
      sensitive: !!sensitive,
      editable:
        !sensitive &&
        !disabled() &&
        !this.readOnly &&
        (this.isContentEditable || /^(INPUT|TEXTAREA)$/.test(this.tagName)),
      options:
        this.tagName === 'SELECT'
          ? Array.from(this.options, (o) => ({
              value: o.value,
              label: o.label,
              selected: o.selected,
              disabled:
                o.disabled || (o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled),
            }))
          : undefined,
      scroll: {
        x: this.scrollLeft,
        y: this.scrollTop,
        width: this.scrollWidth,
        height: this.scrollHeight,
        clientWidth: this.clientWidth,
        clientHeight: this.clientHeight,
      },
    };
  };
  if (action === 'inspect') return state();
  if (!this.isConnected) throw new Error('Element is detached');
  if (action === 'validate') return null;
  if (action === 'hit') return hit(option.x, option.y);
  if (action === 'frame-geometry') {
    const r = this.getBoundingClientRect();
    const m = view.getComputedStyle(this).transform;
    if (m && m !== 'none') {
      const matrix = new view.DOMMatrix(m);
      if (!matrix.is2D || Math.abs(matrix.b) > 0.001 || Math.abs(matrix.c) > 0.001)
        throw new Error('Rotated or perspective iframe geometry is unsupported');
    }
    const sx = r.width / this.offsetWidth,
      sy = r.height / this.offsetHeight;
    return { x: r.x + this.clientLeft * sx, y: r.y + this.clientTop * sy, sx, sy };
  }
  if (action === 'point') {
    if (option === true || option?.scroll)
      this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = this.getBoundingClientRect();
    const x =
      (Math.max(0, r.left ?? r.x) + Math.min(view.innerWidth, r.right ?? r.x + r.width)) / 2;
    const y =
      (Math.max(0, r.top ?? r.y) + Math.min(view.innerHeight, r.bottom ?? r.y + r.height)) / 2;
    if (!r.width || !r.height || !hit(x, y)) throw new Error('Element not visible or covered');
    return { x, y };
  }
  if (action === 'focus') {
    if (sensitive) throw new Error('Password and OTP fields are handled by the user');
    this.focus({ preventScroll: true });
    if (!active()) throw new Error('Could not focus element');
    return null;
  }
  if (action === 'prepare-input') {
    if (sensitive) throw new Error('Password and OTP fields are handled by the user');
    if (
      !(
        this instanceof view.HTMLInputElement ||
        this instanceof view.HTMLTextAreaElement ||
        this.isContentEditable
      ) ||
      disabled() ||
      this.readOnly ||
      this.matches?.('input[type=file]')
    )
      throw new Error('Element is not editable');
    this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    this.focus({ preventScroll: true });
    if (!active()) throw new Error('Could not focus element');
    if (option) {
      if (this.isContentEditable) {
        const range = doc.createRange();
        range.selectNodeContents(this);
        const selection = view.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else this.select();
    }
    const r = this.getBoundingClientRect();
    return {
      x: r.x + Math.min(r.width / 2, 18),
      y: r.y + r.height / 2,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }
  if (action === 'check-focus') {
    if (sensitive) throw new Error('Password and OTP fields are handled by the user');
    if (!active()) throw new Error('Focus changed during input preview');
    return null;
  }
  if (action === 'select') {
    if (!(this instanceof view.HTMLSelectElement) || disabled())
      throw new Error('Element is not an enabled native select');
    if (!this.multiple && option.length !== 1) throw new Error('Single select requires one value');
    for (const value of option) {
      const o = Array.from(this.options).find((o) => o.value === value);
      if (!o || o.disabled || (o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled))
        throw new Error('Option is unavailable');
    }
    for (const o of this.options) o.selected = option.includes(o.value);
    this.dispatchEvent(new view.Event('input', { bubbles: true }));
    this.dispatchEvent(new view.Event('change', { bubbles: true }));
    return state();
  }
  if (action === 'scroll') {
    const horizontal = option.deltaX !== 0;
    if (horizontal ? this.scrollWidth <= this.clientWidth : this.scrollHeight <= this.clientHeight)
      throw new Error('Element is not scrollable in this direction');
    this.scrollBy({ left: option.deltaX, top: option.deltaY, behavior: 'instant' });
    return { x: this.scrollLeft, y: this.scrollTop };
  }
  throw new Error('Unsupported DOM action');
}
