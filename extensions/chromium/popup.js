async function getAllCookiesForUrl(url) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url }, (cookies) => resolve(cookies || []));
  });
}

async function buildCookieHeader() {
  // Collect by URL ensures HttpOnly cookies for the exact URL are accessible via API
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

document.getElementById('btn-sync').addEventListener('click', async () => {
  let backend = document.getElementById('backend').value.trim() || 'http://localhost:3000';
  // sanitize: remove trailing slash or dot
  backend = backend.replace(/\/$/, '').replace(/\.$/, '');
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

    // If server returned a one-time adoption token, open adoption URL to attach cookie to UI session
    if (data.token) {
      const adoptUrl = backend.replace(/\/$/, '') + '/auth/adopt?token=' + encodeURIComponent(data.token);
      try { chrome.tabs.create({ url: adoptUrl }); } catch (_) {}
    }
  } catch (e) {
    status.textContent = 'Failed to sync: ' + e.message;
    status.className = 'hint error';
  }
});


