(function(){
  function getBackend() {
    try { return window.__BACKEND_OVERRIDE__ || window.location.origin; } catch (_) { return window.location.origin; }
  }

  window.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    if (msg && msg.type === 'UV_EXTENSION_SIGNIN') {
      chrome.runtime.sendMessage({ type: 'EXT_SYNC_COOKIE', backend: msg.backend || getBackend() }, (resp) => {
        // Optionally relay back to page
        window.postMessage({ type: 'UV_EXTENSION_SIGNIN_RESULT', result: resp }, '*');
      });
    }
  });
})();


