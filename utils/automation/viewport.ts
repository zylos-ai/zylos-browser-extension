// Join accessibility nodes to Chrome's batched layout snapshot. Geometry stays
// local; only the visible accessibility text/refs enter the Agent observation.
export type Rect = { x: number; y: number; width: number; height: number };
export const viewportStyles = ['overflow-x', 'overflow-y', 'visibility', 'opacity'];
export type LayoutDocument = {
  frameId: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  nodes: { parentIndex: number[]; backendNodeId: number[] };
  layout: { nodeIndex: number[]; bounds: number[][]; styles: number[][]; text: number[] };
  textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] };
};
export type LayoutSnapshot = { documents: LayoutDocument[]; strings: string[] };

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}
export const hasArea = (r: Rect) => r.width > 0 && r.height > 0;

export function visibleLayout(document: LayoutDocument, strings: string[], viewport: Rect) {
  const { nodes, layout, textBoxes } = document;
  const byNode = new Map(layout.nodeIndex.map((node, i) => [node, i]));
  const rect = (b: number[]): Rect => ({
    x: b[0]! - (document.scrollOffsetX || 0),
    y: b[1]! - (document.scrollOffsetY || 0),
    width: b[2]!,
    height: b[3]!,
  });
  const style = (i: number, k: number) => strings[layout.styles[i]?.[k] ?? -1] || '';
  const clips = new Map<number, Rect>();
  // Nodes are flattened in parent-before-child order. A nested scrolling box
  // clips its descendants even though their layout bounds still exist.
  for (let node = 0; node < nodes.parentIndex.length; node++) {
    let clip = clips.get(nodes.parentIndex[node]!) || viewport;
    const i = byNode.get(node);
    if (i !== undefined) {
      const b = rect(layout.bounds[i]!);
      if (style(i, 3) === '0') clip = { ...clip, width: 0, height: 0 };
      else {
        const overlap = intersect(clip, b);
        if (['hidden', 'clip', 'auto', 'scroll'].includes(style(i, 0)))
          clip = { ...clip, x: overlap.x, width: overlap.width };
        if (['hidden', 'clip', 'auto', 'scroll'].includes(style(i, 1)))
          clip = { ...clip, y: overlap.y, height: overlap.height };
      }
    }
    clips.set(node, clip);
  }
  const visible = new Map<number, { text?: string }>();
  const visibleText = new Map<number, string[]>();
  // A single long paragraph can span many screens. Use rendered line boxes so
  // its StaticText does not keep returning the beginning after scrolling.
  for (let j = 0; j < textBoxes.layoutIndex.length; j++) {
    const i = textBoxes.layoutIndex[j]!;
    const node = layout.nodeIndex[i]!;
    if (!hasArea(intersect(rect(textBoxes.bounds[j]!), clips.get(node) || viewport))) continue;
    const text = strings[layout.text[i]!] || '';
    const parts = visibleText.get(i) || [];
    parts.push(text.slice(textBoxes.start[j], textBoxes.start[j]! + textBoxes.length[j]!));
    visibleText.set(i, parts);
  }
  for (let i = 0; i < layout.nodeIndex.length; i++) {
    const node = layout.nodeIndex[i]!;
    if (['hidden', 'collapse'].includes(style(i, 2))) continue;
    if (!hasArea(intersect(rect(layout.bounds[i]!), clips.get(node) || viewport))) continue;
    const parts = visibleText.get(i);
    visible.set(nodes.backendNodeId[node]!, parts ? { text: parts.join(' ') } : {});
  }
  return visible;
}
