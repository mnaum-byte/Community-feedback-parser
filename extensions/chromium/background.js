async function getAllCookiesForUrl(url) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url }, (cookies) => resolve(cookies || []));
  });
}

async function buildCookieHeader() {
  const urls = [
    'https://adobeexpress.uservoice.com/',
    'https://adobeexpress.uservoice.com/forums/951181-adobe-express'
  ];
  const all = [];
  for (const u of urls) {
    const part = await getAllCookiesForUrl(u);
    all.push(...part);
  }
  const pairs = Array.from(new Set(all.map(c => `${c.name}=${c.value}`)));
  return pairs.join('; ');
}

async function postCookie(backend, cookie) {
  const url = backend.replace(/\/$/, '') + '/auth/upload';
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie }) });
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'EXT_SYNC_COOKIE') {
      try {
        const backend = (msg.backend || '').replace(/\/$/, '').replace(/\.$/, '') || 'http://localhost:3000';
        const cookie = await buildCookieHeader();
        if (!cookie) return sendResponse({ ok: false, error: 'no_cookie' });
        const data = await postCookie(backend, cookie);
        if (data.token) {
          const adoptUrl = backend.replace(/\/$/, '') + '/auth/adopt?token=' + encodeURIComponent(data.token);
          try { chrome.tabs.create({ url: adoptUrl }); } catch (_) {}
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }
  })();
  return true; // keep channel open for async response
});


