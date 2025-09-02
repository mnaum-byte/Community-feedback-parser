const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { initSSE } = require('./sse');
const { jobManager } = require('./jobs');
const { findRelevantThreads, extractRelevantComments } = require('./scrape');
const { prepareQueryContext } = require('./matcher');
const { createClient } = require('./request');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(session({
	secret: process.env.SESSION_SECRET || 'uv-secret',
	resave: false,
	saveUninitialized: true,
	cookie: { secure: false },
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.post('/auth/upload', async (req, res) => {
	const { cookie } = req.body || {};
	if (!cookie || typeof cookie !== 'string') return res.status(400).json({ ok: false, error: 'cookie string required' });
	req.session.uservoiceCookie = cookie.trim();
	try { req.session.save(() => {}); } catch (e) {}
	const probe = await probeCookie(req.session.uservoiceCookie);
	res.json({ ok: true, authenticated: probe.authenticated, reason: probe.reason });
});

app.get('/auth/status', async (req, res) => {
	const result = await probeCookie(req.session.uservoiceCookie || '');
	res.json({ authenticated: result.authenticated, reason: result.reason });
});

app.use('/auth/proxy', createProxyMiddleware({
	target: 'https://adobeexpress.uservoice.com',
	changeOrigin: true,
	ws: false,
	followRedirects: true,
	pathRewrite: { '^/auth/proxy': '' },
	onProxyRes: (proxyRes, req, res) => {
		const loc = proxyRes.headers['location'];
		if (loc && typeof loc === 'string' && loc.startsWith('https://adobeexpress.uservoice.com')) {
			try {
				const u = new URL(loc);
				proxyRes.headers['location'] = '/auth/proxy' + u.pathname + (u.search || '');
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
		if (req.session?.uservoiceCookie) {
			proxyReq.setHeader('Cookie', req.session.uservoiceCookie);
		}
	},
}));

// Start forum parse job
app.post('/api/parse/start', async (req, res) => {
	const { cookie, keywords, query } = req.body || {};
	const cookieToUse = cookie || req.session.uservoiceCookie;
	if (!cookieToUse) {
		return res.status(400).json({ error: 'Not authenticated. Sign in or provide a cookie.' });
	}
	const job = jobManager.createJob('parse', { });
	res.json({ jobId: job.id });

	(async () => {
		try {
			jobManager.update(job.id, { status: 'running' });
			const queryCtx = query ? await prepareQueryContext(query) : await prepareQueryContext({ must: keywords || [], optional: [], exclude: [], featureDef: '', useSynonyms: false, useSemantic: false });
			await findRelevantThreads(
				cookieToUse,
				queryCtx,
				(evt) => jobManager.broadcast(job.id, evt.type, evt.data),
				(progress) => jobManager.broadcast(job.id, 'progress', progress)
			);
			jobManager.update(job.id, { status: 'completed', progress: 100 });
			jobManager.broadcast(job.id, 'done', { ok: true });
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
	if (!cookieToUse || !Array.isArray(threads)) {
		return res.status(400).json({ error: 'Not authenticated or missing threads[]' });
	}
	const job = jobManager.createJob('comments', { });
	res.json({ jobId: job.id });

	(async () => {
		try {
			jobManager.update(job.id, { status: 'running' });
			const queryCtx = query ? await prepareQueryContext(query) : await prepareQueryContext({ must: keywords || [], optional: [], exclude: [], featureDef: '', useSynonyms: false, useSemantic: false });
			await extractRelevantComments(
				cookieToUse,
				threads,
				queryCtx,
				Date.now() - 365 * 24 * 60 * 60 * 1000,
				(evt) => jobManager.broadcast(job.id, evt.type, evt.data),
				(progress) => jobManager.broadcast(job.id, 'progress', progress)
			);
			jobManager.update(job.id, { status: 'completed', progress: 100 });
			jobManager.broadcast(job.id, 'done', { ok: true });
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


