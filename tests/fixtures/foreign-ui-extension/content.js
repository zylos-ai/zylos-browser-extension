// Mirrors Surfingkeys 1.19.3 uiframe.js: an open-shadow host on <html> holding an
// iframe of the extension's own frontend page. `?eager` injects at load; otherwise
// the page asks for it later (Surfingkeys creates it on first UI use).
function inject() {
  if (document.querySelector('[data-foreign-ui]')) return;
  const host = document.createElement('div');
  host.dataset.foreignUi = '';
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('frontend.html');
  frame.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;height:0;border:0';
  host.attachShadow({ mode: 'open' }).appendChild(frame);
  document.documentElement.appendChild(host);
}
if (new URL(location.href).searchParams.has('eager')) inject();
addEventListener('message', (event) => {
  if (event.source === window && event.data === 'foreign-ui-inject') inject();
});
