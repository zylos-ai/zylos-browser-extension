// Trusted, fixed helper. Selectors and text are data, never executable source.
function pageQuery(action, value) {
  const deep = (root, selector) => {
    const result = Array.from(root.querySelectorAll(selector));
    for (const node of root.querySelectorAll('*'))
      if (node.shadowRoot) result.push(...deep(node.shadowRoot, selector));
    return result;
  };
  if (action === 'query') return deep(document, value).slice(0, 100);
  if (action === 'text') {
    let output = document.body?.innerText || '';
    for (const node of deep(document, '*'))
      if (node.shadowRoot) output += '\n' + (node.shadowRoot.textContent || '');
    return output.includes(value);
  }
  if (action === 'ready') return document.readyState;
  if (action === 'viewport') return { x: 0, y: 0, width: innerWidth, height: innerHeight };
  if (action === 'focus') {
    let node = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return {
      focused: document.hasFocus(),
      sensitive: !!node?.matches('input[type=password],input[autocomplete=one-time-code]'),
    };
  }
}
