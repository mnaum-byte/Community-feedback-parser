## UserVoice feedback extractor for Adobe Express

Run locally:

```bash
npm run dev
```

Then open `http://localhost:3000`.

Paste your `adobeexpress.uservoice.com` browser cookie and comma-separated keywords. Click "Parse Forum" then "Extract user comments".

Environment variables:

- `PORT` - default 3000
- `HTTP_TIMEOUT_MS` - default 20000
- `FORUM_CONCURRENCY` - default 3 (parallel page fetches)
- `THREADS_CONCURRENCY` - default 2 (parallel comment extraction across threads)
- `COMMENTS_PAGE_CONCURRENCY` - default 3 (parallel pages per thread)

Deploy (single-origin on Render/Railway):

1) Connect this repo as a Web/Service with Start command: `npm run start`. Node 18+.
2) Set env vars: `SESSION_SECRET`, `HTTP_TIMEOUT_MS` (e.g., 20000), optional `OPENAI_API_KEY`, and concurrency knobs above.
3) Domain: add your custom domain and enable HTTPS.
4) Browser extension: set backend URL to your domain and click "Sync cookie".
5) Production is configured for secure cookies behind HTTPS (trust proxy enabled).

Browser extensions (cookie sync):

- Chromium (Chrome/Edge/Brave/Arc): load `extensions/chromium` as an unpacked extension. Open a tab at `https://adobeexpress.uservoice.com`, ensure you are signed in, click the extension, then "Sync cookie". The backend will store and probe the cookie and the app will show "Signed in".
- Firefox: load `extensions/firefox` as a temporary add-on. Open a tab at `https://adobeexpress.uservoice.com`, sign in, open the extension, and press "Sync cookie".

Notes:
- Requires a valid session cookie to access all content. Do not share cookies.
- Live updates use SSE; keep the tab open while jobs run.


