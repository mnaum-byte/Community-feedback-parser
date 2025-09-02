async function getAllCookiesForUrl(url) {
  return browser.cookies.getAll({ url });
}

async function buildCookieHeader() {
  const urls = ['https://adobeexpress.uservoice.com/'];
  const all = [];
  for (const url of urls) {
    const part = await getAllCookiesForUrl(url);
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

document.getElementById('btn-sync').addEventListener('click', async () => {
  const backend = document.getElementById('backend').value.trim() || 'http://localhost:3000';
  const status = document.getElementById('status');
  status.textContent = 'Collecting cookies...';
  try {
    const cookie = await buildCookieHeader();
    if (!cookie) {
      status.textContent = 'No cookies found. Log in at adobeexpress.uservoice.com and try again.';
      status.className = 'hint error';
      return;
    }
    status.textContent = 'Uploading...';
    const data = await postCookie(backend, cookie);
    if (data.ok && data.authenticated) {
      status.textContent = 'Synced and authenticated.';
      status.className = 'hint ok';
    } else {
      status.textContent = `Uploaded, but not authenticated (${data.reason || 'unknown'}).`;
      status.className = 'hint error';
    }

    if (data.token) {
      const adoptUrl = backend.replace(/\/$/, '') + '/auth/adopt?token=' + encodeURIComponent(data.token);
      try { browser.tabs.create({ url: adoptUrl }); } catch (_) {}
    }
  } catch (e) {
    status.textContent = 'Failed to sync: ' + e.message;
    status.className = 'hint error';
  }
});


