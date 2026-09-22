import { afterEach, expect, test, vi } from 'vitest';
import {
  extractPageSelection,
  MAX_SELECTION_TEXT,
  pageSelectionSchema,
  readPageSelection,
} from '../../utils/page-selection';

afterEach(() => {
  const scope = globalThis as { __zylosSelectionPreview?: { dispose: () => void } };
  scope.__zylosSelectionPreview?.dispose();
  delete scope.__zylosSelectionPreview;
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}
test('reads only the selected passage, preserving line breaks and bounding long selections', () => {
  document.body.innerHTML =
    '<p>Not selected</p><article>Selected first line\nSecond line</article>';
  select(document.querySelector('article')!);
  expect(extractPageSelection(MAX_SELECTION_TEXT)).toMatchObject({
    text: 'Selected first line\nSecond line',
    truncated: false,
  });
  document.querySelector('article')!.textContent = 'x'.repeat(5000);
  select(document.querySelector('article')!);
  expect(extractPageSelection(MAX_SELECTION_TEXT)).toMatchObject({
    text: 'x'.repeat(4000),
    truncated: true,
  });
  window.getSelection()!.removeAllRanges();
  expect(extractPageSelection(MAX_SELECTION_TEXT).text).toBe('');
});
test.each([
  '<textarea>private</textarea>',
  '<div contenteditable>private</div>',
  '<div role="textbox">private</div>',
])('omits editor contents while preserving surrounding selected prose: %s', (html) => {
  document.body.innerHTML = `<section><p>Public</p>${html}</section>`;
  select(document.querySelector('section')!.lastChild!);
  expect(extractPageSelection(MAX_SELECTION_TEXT).text).toBe('');
  select(document.querySelector('section')!);
  expect(extractPageSelection(MAX_SELECTION_TEXT).text).toBe('Public');
});
test('mixed selections retain exact text boundaries and skip fields, drafts and invisible content', () => {
  document.body.innerHTML = `<section>
    <p id="start">Unselected prefix: Video title</p>
    <input hidden value="PRIVATE_HIDDEN_FIELD">
    <input type="password" value="PRIVATE_PASSWORD">
    <textarea>PRIVATE_TEXTAREA</textarea>
    <div contenteditable>PRIVATE_DRAFT</div>
    <select><option>PRIVATE_OPTION</option></select>
    <p hidden>PRIVATE_HIDDEN_TEXT</p>
    <span style="display:none">PRIVATE_CSS_HIDDEN</span>
    <script>PRIVATE_SCRIPT</script>
    <p id="end">Danmaku etiquette: Unselected suffix</p>
  </section>`;
  const range = document.createRange();
  range.setStart(document.querySelector('#start')!.firstChild!, 'Unselected prefix: '.length);
  range.setEnd(document.querySelector('#end')!.firstChild!, 'Danmaku etiquette'.length);
  window.getSelection()!.addRange(range);
  const result = extractPageSelection(MAX_SELECTION_TEXT);
  expect(result.text).toContain('Video title');
  expect(result.text).toContain('Danmaku etiquette');
  expect(result.text).not.toMatch(/PRIVATE_|Unselected/);
  expect(result.truncated).toBe(false);
});
test('a range beginning in an editor keeps its selected prose outside that editor', () => {
  document.body.innerHTML =
    '<section><div contenteditable>Private</div><p>Public end</p></section>';
  const range = document.createRange();
  range.setStart(document.querySelector('[contenteditable]')!.firstChild!, 2);
  range.setEnd(document.querySelector('p')!.firstChild!, 6);
  window.getSelection()!.addRange(range);
  expect(extractPageSelection(MAX_SELECTION_TEXT).text).toBe('Public');
});
test('mixed selections remain bounded and do not include text after the size limit', () => {
  document.body.innerHTML = `<section><input hidden value="private"><p>${'x'.repeat(5000)}</p><p>Later</p></section>`;
  select(document.querySelector('section')!);
  expect(extractPageSelection(MAX_SELECTION_TEXT)).toMatchObject({
    text: 'x'.repeat(4000),
    truncated: true,
  });
});
test('does not expose password or input selections even when document selection remains', () => {
  document.body.innerHTML = '<p>Article</p><input type="password" value="secret">';
  select(document.querySelector('p')!);
  document.querySelector('input')!.focus();
  expect(extractPageSelection(MAX_SELECTION_TEXT).text).toBe('');
});
test('validates transport bounds and ignores a stalled page without using CDP', async () => {
  expect(
    pageSelectionSchema.safeParse({
      text: 'x'.repeat(4001),
      truncated: false,
      tabId: 1,
      documentId: 'doc',
      url: 'https://example.com',
      title: 'Page',
    }).success,
  ).toBe(false);
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(() => new Promise(() => {})) } });
  const pending = expect(readPageSelection(3)).rejects.toThrow('SELECTION_TIMEOUT');
  await vi.advanceTimersByTimeAsync(1501);
  await pending;
});

test('the observer clears cancelled selections and distinguishes reselecting the same words', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p>Short quotation</p>';
  extractPageSelection(MAX_SELECTION_TEXT, true);
  select(document.querySelector('p')!);
  document.dispatchEvent(new Event('selectionchange'));
  const first = extractPageSelection(MAX_SELECTION_TEXT, true);
  window.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
  const cleared = extractPageSelection(MAX_SELECTION_TEXT, true);
  expect(cleared.text).toBe('');
  select(document.querySelector('p')!);
  document.dispatchEvent(new Event('selectionchange'));
  const reselected = extractPageSelection(MAX_SELECTION_TEXT, true);
  expect(reselected).toMatchObject({
    text: 'Short quotation',
  });
  expect(reselected).not.toEqual(first);
  await vi.advanceTimersByTimeAsync(2001);
  expect(
    (globalThis as { __zylosSelectionPreview?: { listening: boolean } }).__zylosSelectionPreview
      ?.listening,
  ).toBe(false);
  expect(extractPageSelection(MAX_SELECTION_TEXT, true)).toEqual(reselected);
});
