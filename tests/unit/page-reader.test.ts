// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { extractPageText } from '../../utils/page-reader';
const { getBoundingClientRect } = Element.prototype;
const range = {
  selectNodeContents: Range.prototype.selectNodeContents,
  getBoundingClientRect: Range.prototype.getBoundingClientRect,
};
afterEach(() => {
  document.body.innerHTML = '';
  Element.prototype.getBoundingClientRect = getBoundingClientRect;
  Range.prototype.selectNodeContents = range.selectNodeContents;
  Range.prototype.getBoundingClientRect = range.getBoundingClientRect;
});

test('reads rendered text and real links while omitting fields, hidden content and scripts', () => {
  document.body.innerHTML = `<main><h1>Article</h1><p>One <b>important</b> sentence.</p>
    <a href="https://example.com/source">Original source</a>
    <input value="input-secret"><textarea>textarea-secret</textarea>
    <div contenteditable="true">editable-secret</div><div role="textbox">role-secret</div>
    <div hidden>hidden-secret</div><div style="display:none">css-secret</div>
    <div aria-hidden="true">aria-secret</div><script>script-secret</script>
    <details><summary>Closed section</summary><p>collapsed-secret</p></details></main>`;
  const result = extractPageText();
  expect(result.text).toContain('One important sentence.');
  expect(result.text).toContain('Article');
  expect(result.text).not.toContain('secret');
  expect(result.links).toEqual([{ text: 'Original source', url: 'https://example.com/source' }]);
});

test('includes open shadow text and slotted content once without altering the page', () => {
  document.body.innerHTML = '<div id="host"><span>Slotted text</span></div>';
  const host = document.getElementById('host')!;
  host.attachShadow({ mode: 'open' }).innerHTML =
    '<h2>Shadow heading</h2><slot></slot><input value="secret">';
  const before = host.shadowRoot!.innerHTML;
  const page = extractPageText();
  expect(page.text).toContain('Shadow heading');
  expect(page.text.match(/Slotted text/g)).toHaveLength(1);
  expect(page.text).not.toContain('secret');
  expect(host.shadowRoot!.innerHTML).toBe(before);
});

test('chunks are bounded, have stable offsets/version, and report extraction limits', () => {
  document.body.innerHTML = '<p>' + 'article '.repeat(3000) + '</p>';
  const first = extractPageText({ limit: 6000 });
  const second = extractPageText({ offset: first.nextOffset!, limit: 12000 });
  expect(first.text.length).toBe(6000);
  expect(second.text.length).toBe(12000);
  expect(second.offset).toBe(6000);
  expect(second.contentVersion).toBe(first.contentVersion);
  const rest = extractPageText({ offset: second.nextOffset!, limit: 12000 });
  expect(rest.nextOffset).toBeNull();
  expect(first.text + second.text + rest.text).toBe(
    document.querySelector('p')!.textContent!.trim(),
  );
  document.querySelector('p')!.textContent = 'x'.repeat(150000);
  const capped = extractPageText({ offset: 119990, limit: 12000 });
  expect(capped.limited).toBe(true);
  expect(capped.truncated).toBe(true);
  expect(capped.nextOffset).toBeNull();
  expect(capped.contentVersion).not.toBe(first.contentVersion);
});

test('viewport digest lists only on-screen content as role lines without form values', () => {
  document.body.innerHTML = `<h1>Above the fold</h1><p id="gone">scrolled-away</p>
    <section id="seen"><h2>Order details</h2><p>Ship to <b>Main St</b></p>
    <a href="https://example.com/orders/1">Order #1</a><button>Refund</button>
    <input aria-label="Coupon" value="input-secret"><img alt="Product photo"></section>
    <p id="below">below-fold</p>`;
  const offscreen = { left: 0, top: -500, right: 800, bottom: -400 } as DOMRect;
  const onscreen = { left: 0, top: 100, right: 800, bottom: 140 } as DOMRect;
  const inSeen = (node: Node) => !!node && document.getElementById('seen')!.contains(node);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this === document.body || inSeen(this) ? onscreen : offscreen;
  };
  let selected: Node;
  Range.prototype.selectNodeContents = function (node: Node) {
    selected = node;
  };
  Range.prototype.getBoundingClientRect = () => (inSeen(selected) ? onscreen : offscreen);
  const page = extractPageText({ overview: true });
  expect(page.viewport!.text.split('\n')).toEqual([
    '- heading "Order details"',
    '- StaticText "Ship to Main St"',
    '- link "Order #1" {"url":"https://example.com/orders/1"}',
    '- button "Refund"',
    '- textbox "Coupon"',
    '- img "Product photo"',
  ]);
  expect(page.viewport).toMatchObject({ truncated: false, width: innerWidth });
  expect(page.text).toContain('scrolled-away');
  expect(page.outline).toEqual([
    { level: 1, name: 'Above the fold', offset: 0, position: 'above' },
    { level: 2, name: 'Order details', offset: expect.any(Number), position: 'in-view' },
  ]);
  const full = extractPageText({ limit: 12000 });
  expect(full.text.slice(page.outline![1]!.offset)).toMatch(/^Order details\n\nShip to Main St/);
  expect(full.contentVersion).toBe(page.contentVersion);
  expect(full).not.toHaveProperty('viewport');
  expect(full).not.toHaveProperty('outline');
});

test('outline offsets follow document order for repeated heading text', () => {
  document.body.innerHTML =
    '<h2>Reviews</h2><p>Reviews are below.</p><h2 role="none">Reviews</h2><div role="heading" aria-level="3">Latest</div><h4></h4>';
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const { text, outline } = extractPageText({ overview: true });
  expect(outline!.map((h) => [h.level, h.name])).toEqual([
    [2, 'Reviews'],
    [2, 'Reviews'],
    [3, 'Latest'],
  ]);
  const offsets = outline!.map((h) => h.offset!);
  expect(offsets[0]).toBe(0);
  expect(offsets[1]).toBe(text.lastIndexOf('Reviews'));
  expect(text.slice(offsets[2])).toBe('Latest');
});
