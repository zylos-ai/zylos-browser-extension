// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { extractPageText } from '../../utils/page-reader';
afterEach(() => {
  document.body.innerHTML = '';
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
