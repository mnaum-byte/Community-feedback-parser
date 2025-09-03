const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { initSSE } = require('./sse');
const { jobManager } = require('./jobs');
const { findRelevantThreads: scrapeThreads, extractRelevantComments: scrapeComments } = require('./scrape');
const { prepareQueryContext } = require('./matcher');
const { createClient } = require('./request');
const { nanoid } = require('nanoid');
const { createApiClient, listSuggestionsUpdatedSince, listCommentsForSuggestion } = require('./uvapi');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS for extension origins (and optionally any origin for auth endpoints)
app.use(cors({
	origin: function(origin, cb) {
		// Allow requests with no origin (like curl) or our extension origins
		if (!origin) return cb(null, true);
		if (/^chrome-extension:/.test(origin) || /^moz-extension:/.test(origin)) return cb(null, true);
		if (process.env.CORS_ORIGIN && origin === process.env.CORS_ORIGIN) return cb(null, true);
		// Also allow our own origin
		if (origin && process.env.RENDER_EXTERNAL_URL && origin === process.env.RENDER_EXTERNAL_URL) return cb(null, true);
		return cb(null, true); // be permissive for now; lock down later
	},
	credentials: true
}));
app.use(express.json({ limit: '1mb' }));
// Trust proxy for correct secure cookies behind reverse proxies (Render/Railway)
app.set('trust proxy', 1);
app.use(session({
	secret: process.env.SESSION_SECRET || 'uv-secret',
	resave: false,
	saveUninitialized: true,
	cookie: { 
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax'
	},
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
// Serve XLSX bundle locally for reliable exports on localhost
try {
    const xlsxPath = require.resolve('xlsx/dist/xlsx.full.min.js');
    const xlsxDistDir = path.dirname(xlsxPath);
    app.use('/vendor', express.static(xlsxDistDir, { extensions: ['js','map'] }));
} catch (_) {}

async function probeCookie(uservoiceCookie) {
	if (!uservoiceCookie) return { authenticated: false, reason: 'no_cookie' };
	try {
		const client = createClient(uservoiceCookie);
		const res = await client.get('/forums/951181-adobe-express');
		const html = String(res.data || '');
		const isLogin = /Continue with email/i.test(html) || /Sign in/i.test(html) && !/Sign out/i.test(html);
		return { authenticated: !isLogin, reason: isLogin ? 'login_page' : 'ok' };
	} catch (e) {
		return { authenticated: false, reason: 'request_failed' };
	}
}

app.get('/health', (req, res) => {
	res.json({ ok: true });
});

// One-time token store to adopt cookies from extension to current UI session
const adoptTokens = new Map(); // token -> { cookie, expiresAt }
const ADOPT_TTL_MS = 2 * 60 * 1000;

// Called by the browser extension. Returns a one-time token for adoption.
app.post('/auth/upload', async (req, res) => {
	const { cookie } = req.body || {};
	if (!cookie || typeof cookie !== 'string') return res.status(400).json({ ok: false, error: 'cookie string required' });
	const trimmed = cookie.trim();
	const probe = await probeCookie(trimmed);
	const token = nanoid();
	adoptTokens.set(token, { cookie: trimmed, expiresAt: Date.now() + ADOPT_TTL_MS });
	res.json({ ok: true, authenticated: probe.authenticated, reason: probe.reason, token });
});

// UI calls this (or the extension opens it) to attach the uploaded cookie to this browser session
app.get('/auth/adopt', async (req, res) => {
	const { token } = req.query || {};
	if (!token || typeof token !== 'string') return res.status(400).send('Missing token');
	const entry = adoptTokens.get(token);
	if (!entry) return res.status(410).send('Token expired');
	if (Date.now() > entry.expiresAt) {
		adoptTokens.delete(token);
		return res.status(410).send('Token expired');
	}
	req.session.uservoiceCookie = entry.cookie;
	try { req.session.save(() => {}); } catch (e) {}
	adoptTokens.delete(token);
	res.redirect('/');
});

app.get('/auth/status', async (req, res) => {
	const result = await probeCookie(req.session.uservoiceCookie || '');
	res.json({ authenticated: result.authenticated, reason: result.reason, oauth: !!process.env.UV_OAUTH_TOKEN });
});

// Dynamic host-aware proxy for *.uservoice.com
app.use('/auth/proxy/_host/:host', createProxyMiddleware({
	target: 'https://adobeexpress.uservoice.com',
	changeOrigin: true,
	ws: false,
	followRedirects: true,
	router: (req) => `https://${req.params.host}`,
	pathRewrite: (path, req) => path.replace(new RegExp(`^/auth/proxy/_host/${req.params.host}`), ''),
	onProxyRes: (proxyRes, req, res) => {
		const loc = proxyRes.headers['location'];
		if (loc && typeof loc === 'string') {
			try {
				const u = new URL(loc);
				if (/\.uservoice\.com$/i.test(u.hostname)) {
					proxyRes.headers['location'] = `/auth/proxy/_host/${u.hostname}${u.pathname}${u.search || ''}`;
				}
			} catch (_) {}
		}
		const setCookie = proxyRes.headers['set-cookie'];
		if (setCookie && setCookie.length) {
			const pairs = setCookie.map(c => (c || '').split(';')[0]).filter(Boolean);
			const prev = req.session.uservoiceCookie || '';
			const mergedSet = new Set((prev ? prev.split('; ') : []).concat(pairs));
			req.session.uservoiceCookie = Array.from(mergedSet).join('; ');
			console.log('[auth] captured cookies:', req.session.uservoiceCookie);
			try { req.session.save(() => {}); } catch (e) {}
		}
	},
	onProxyReq: (proxyReq, req, res) => {
		if (req.session?.uservoiceCookie) proxyReq.setHeader('Cookie', req.session.uservoiceCookie);
	},
}));

// Default proxy
app.use('/auth/proxy', createProxyMiddleware({
	target: 'https://adobeexpress.uservoice.com',
	changeOrigin: true,
	ws: false,
	followRedirects: true,

	
	pathRewrite: { '^/auth/proxy': '' },
	onProxyRes: (proxyRes, req, res) => {
		const loc = proxyRes.headers['location'];
		if (loc && typeof loc === 'string') {
			try {
				const u = new URL(loc);
				if (/\.uservoice\.com$/i.test(u.hostname)) {
					proxyRes.headers['location'] = `/auth/proxy/_host/${u.hostname}${u.pathname}${u.search || ''}`;
				}
			} catch (_) {}
		}
		const setCookie = proxyRes.headers['set-cookie'];
		if (setCookie && setCookie.length) {
			const pairs = setCookie.map(c => (c || '').split(';')[0]).filter(Boolean);
			const prev = req.session.uservoiceCookie || '';
			const mergedSet = new Set((prev ? prev.split('; ') : []).concat(pairs));
			req.session.uservoiceCookie = Array.from(mergedSet).join('; ');
			console.log('[auth] captured cookies:', req.session.uservoiceCookie);
			try { req.session.save(() => {}); } catch (e) {}
		}
	},
	onProxyReq: (proxyReq, req, res) => {
		if (req.session?.uservoiceCookie) proxyReq.setHeader('Cookie', req.session.uservoiceCookie);
	},
}));

// Start forum parse job
app.post('/api/parse/start', async (req, res) => {
	const { cookie, keywords, query } = req.body || {};
	const cookieToUse = cookie || req.session.uservoiceCookie;
	const token = process.env.UV_OAUTH_TOKEN || '';
	if (!cookieToUse && !token) {
		return res.status(400).json({ error: 'Not authenticated. Sign in, provide a cookie, or set UV_OAUTH_TOKEN.' });
	}
	const job = jobManager.createJob('parse', { });
	res.json({ jobId: job.id });

	(async () => {
		try {
			jobManager.update(job.id, { status: 'running' });
			const queryCtx = query ? await prepareQueryContext(query) : await prepareQueryContext({ must: keywords || [], optional: [], exclude: [], featureDef: '', useSynonyms: false, useSemantic: false });
			if (token) {
				const client = createApiClient(token);
				const sinceIso = null; // fetch all and let matching filter relevance
				let scanned = 0; let relevant = 0; let total = 0;
				const concurrency = Number(process.env.THREADS_CONCURRENCY || 4);
				await require('./uvapi').streamSuggestionsUpdatedSince(client, sinceIso, async (pageItems, pagination, perPage) => {
					total = pagination?.total_entries || pagination?.total || (pagination?.total_pages ? pagination.total_pages * perPage : Math.max(total, scanned + pageItems.length));
					// Process this page with limited concurrency
					let idx = 0;
					async function worker() {
						while (idx < pageItems.length) {
							const s = pageItems[idx++];
							const resMatch = await require('./matcher').matchItem(`${s.title} ${s.description}`, queryCtx);
							if (resMatch.isMatch) {
								relevant += 1;
								jobManager.broadcast(job.id, 'thread', { ...s, _why: resMatch.why });
							}
							scanned += 1;
							jobManager.broadcast(job.id, 'progress', { phase: 'api', scannedThreads: scanned, totalThreads: total, totalRelevant: relevant });
						}
					}
					const workers = Array.from({ length: Math.min(concurrency, pageItems.length) }, () => worker());
					await Promise.all(workers);
				});
				jobManager.update(job.id, { status: 'completed', progress: 100 });
				jobManager.broadcast(job.id, 'done', { ok: true });
			} else {
				await scrapeThreads(
					cookieToUse,
					queryCtx,
					(evt) => jobManager.broadcast(job.id, evt.type, evt.data),
					(progress) => jobManager.broadcast(job.id, 'progress', progress)
				);
				jobManager.update(job.id, { status: 'completed', progress: 100 });
				jobManager.broadcast(job.id, 'done', { ok: true });
			}
		} catch (e) {
			jobManager.update(job.id, { status: 'error', error: e.message });
			jobManager.broadcast(job.id, 'error', { message: e.message });
		}
	})();
});

// SSE for parse job
app.get('/api/parse/events/:jobId', (req, res) => {
	const { jobId } = req.params;
	const job = jobManager.getJob(jobId);
	if (!job) return res.status(404).end();
	const sse = initSSE(res);
	const listener = (event, data) => sse.send(event, data);
	jobManager.addListener(jobId, listener);
	res.on('close', () => jobManager.removeListener(jobId, listener));
	sse.send('connected', { jobId });
});

// Start comments extraction
app.post('/api/comments/start', async (req, res) => {
	const { cookie, keywords, threads, query } = req.body || {};
	const cookieToUse = cookie || req.session.uservoiceCookie;
	const token = process.env.UV_OAUTH_TOKEN || '';
	if ((!cookieToUse && !token) || !Array.isArray(threads)) {
		return res.status(400).json({ error: 'Not authenticated or missing threads[]' });
	}
	const job = jobManager.createJob('comments', { });
	res.json({ jobId: job.id });

	(async () => {
		try {
			jobManager.update(job.id, { status: 'running' });
			const queryCtx = query ? await prepareQueryContext(query) : await prepareQueryContext({ must: keywords || [], optional: [], exclude: [], featureDef: '', useSynonyms: false, useSemantic: false });
			if (token) {
				const client = createApiClient(token);
				let processed = 0; let totalRelevant = 0;
				for (const t of threads) {
					const idMatch = String(t.id || '').match(/\d+/);
					const suggId = t.id || (idMatch ? Number(idMatch[0]) : null);
					if (!suggId) { processed += 1; continue; }
					let idx = 0;
					await require('./uvapi').streamCommentsForSuggestion(client, suggId, async (pageComments, pagination) => {
						for (const c of pageComments) {
							let resMatch = await require('./matcher').matchItem(c.body, queryCtx);
							if (!resMatch.isMatch && (queryCtx.must || []).length) {
								const optional = Array.from(new Set([...(queryCtx.optional || []), ...(queryCtx.must || [])]));
								resMatch = await require('./matcher').matchItem(c.body, { ...queryCtx, must: [], optional });
							}
							if (!resMatch.isMatch) resMatch = await require('./matcher').matchItem(`${t.title} ${c.body}`, queryCtx);
							if (resMatch.isMatch) {
								totalRelevant += 1;
								jobManager.broadcast(job.id, 'comment', { body: c.body, url: c.url || t.url, threadTitle: t.title, threadUrl: t.url, _why: resMatch.why });
							}
							idx += 1;
							jobManager.broadcast(job.id, 'progress', { threadIndex: processed + 1, pageIndex: idx, totalPages: (pagination?.total_entries || 0), totalRelevant });
						}
					});
					processed += 1;
				}
				jobManager.update(job.id, { status: 'completed', progress: 100 });
				jobManager.broadcast(job.id, 'done', { ok: true });
			} else {
				await scrapeComments(
					cookieToUse,
					threads,
					queryCtx,
					Date.now() - 365 * 24 * 60 * 60 * 1000,
					(evt) => jobManager.broadcast(job.id, evt.type, evt.data),
					(progress) => jobManager.broadcast(job.id, 'progress', progress)
				);
				jobManager.update(job.id, { status: 'completed', progress: 100 });
				jobManager.broadcast(job.id, 'done', { ok: true });
			}
		} catch (e) {
			jobManager.update(job.id, { status: 'error', error: e.message });
			jobManager.broadcast(job.id, 'error', { message: e.message });
		}
	})();
});

// SSE for comments job
app.get('/api/comments/events/:jobId', (req, res) => {
	const { jobId } = req.params;
	const job = jobManager.getJob(jobId);
	if (!job) return res.status(404).end();
	const sse = initSSE(res);
	const listener = (event, data) => sse.send(event, data);
	jobManager.addListener(jobId, listener);
	res.on('close', () => jobManager.removeListener(jobId, listener));
	sse.send('connected', { jobId });
});

app.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});


