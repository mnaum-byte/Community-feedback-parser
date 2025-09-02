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

Browser extensions (cookie sync):

- Chromium (Chrome/Edge/Brave/Arc): load `extensions/chromium` as an unpacked extension. Open a tab at `https://adobeexpress.uservoice.com`, ensure you are signed in, click the extension, then "Sync cookie". The backend will store and probe the cookie and the app will show "Signed in".
- Firefox: load `extensions/firefox` as a temporary add-on. Open a tab at `https://adobeexpress.uservoice.com`, sign in, open the extension, and press "Sync cookie".

Notes:
- Requires a valid session cookie to access all content. Do not share cookies.
- Live updates use SSE; keep the tab open while jobs run.


