// A single self-contained CDP callFunctionOn body. Imported as raw source, not minified.
function domAction(action, option) {
  if (action === 'validate') {
    if (!this.isConnected || this.ownerDocument !== document)
      throw new Error('Element is detached or in an unsupported frame');
    if (this.matches?.('input[type=password]'))
      throw new Error('Password fields are handled by the user');
    return null;
  }
  if (action === 'point') {
    // Keep already visible fields/buttons in place; scroll only the necessary distance.
    if (option) this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = this.getBoundingClientRect();
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!r.width || !r.height || !(hit === this || this.contains(hit)))
      throw new Error('Element not visible or covered');
    return { x, y };
  }
  if (action === 'prepare-input') {
    if (
      !(
        this instanceof HTMLInputElement ||
        this instanceof HTMLTextAreaElement ||
        this.isContentEditable
      ) ||
      this.disabled ||
      this.readOnly
    )
      throw new Error('Element is not editable');
    this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    this.focus({ preventScroll: true });
    if (document.activeElement !== this) throw new Error('Could not focus element');
    if (option) {
      if (this.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(this);
        const selection = window.getSelection();
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
    if (document.activeElement !== this) throw new Error('Focus changed during input preview');
    return null;
  }
  throw new Error('Unsupported DOM action');
}
