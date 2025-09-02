const cheerio = require('cheerio');
const { createClient, BASE_URL } = require('./request');
const { matchItem } = require('./matcher');

function normalizeUrl(href) {
	if (!href) return null;
	if (href.startsWith('http')) return href;
	return BASE_URL + href;
}

function toRelative(url) {
	if (!url) return null;
	return url.startsWith('http') ? url.replace(BASE_URL, '') : url;
}

function textContent($el) {
	return $el.text().trim().replace(/\s+/g, ' ');
}

async function listAllForumPages(client, onDiscover, onPageHtml) {
	let path = '/forums/951181-adobe-express';
	const visited = new Set();
	const pages = [];
	let discovered = 0;
	while (path && !visited.has(path)) {
		visited.add(path);
		const res = await client.get(path);
		if (res.status >= 400) throw new Error(`Failed to load ${path}: ${res.status}`);
		pages.push({ path, html: res.data });
		discovered += 1;
		onPageHtml?.(res.data, path, discovered);
		onDiscover?.({ phase: 'discover', discoveredPages: discovered, currentPath: path });
		const $ = cheerio.load(res.data);
		let next = $('a.next_page, a[rel="next"]').attr('href');
		next = toRelative(next);
		path = next || null;
	}
	return pages; // [{path, html}]
}

function parseThreadsFromPage(html) {
	const $ = cheerio.load(html);
	const rows = [];
	$('.suggestions li, .feedback li, .uvIdea').each((_, el) => {
		const titleEl = $(el).find('a, h3 a').first();
		const title = textContent(titleEl);
		const href = titleEl.attr('href');
		const url = normalizeUrl(href);
		let description = '';
		const descEl = $(el).find('.description, .body, .uvIdeaDescription').first();
		if (descEl && descEl.length) description = textContent(descEl);
		if (title && url) rows.push({ title, description, url });
	});
	return rows;
}

async function findRelevantThreads(cookie, queryCtx, onEvent, onProgress) {
	const client = createClient(cookie);
	const found = [];
	const seenUrls = new Set();
	let scannedThreads = 0;
	let estimatedPerPage = 0;

	async function handlePage(html, path, discoveredPages) {
		const threads = parseThreadsFromPage(html);
		if (discoveredPages === 1) estimatedPerPage = threads.length || 0;
		scannedThreads += threads.length;
		for (const t of threads) {
			const text = `${t.title} ${t.description}`;
			try {
				const res = await matchItem(text, queryCtx);
				if (res.isMatch && !seenUrls.has(t.url)) {
					seenUrls.add(t.url);
					const item = { ...t, _why: res.why };
					found.push(item);
					onEvent?.({ type: 'thread', data: item });
				}
			} catch (_) {}
		}
		const totalPagesSoFar = discoveredPages;
		const totalThreadsEstimate = estimatedPerPage * totalPagesSoFar;
		onProgress?.({ phase: 'discover', pageIndex: discoveredPages, totalPages: totalPagesSoFar, pageThreads: threads.length, totalRelevant: found.length, scannedThreads, totalThreads: totalThreadsEstimate });
	}

	await listAllForumPages(client, (d) => onProgress?.(d), handlePage);
	return found;
}

async function discoverThreadPagination(client, threadUrl) {
	const rel = toRelative(threadUrl.replace(BASE_URL, ''));
	const res = await client.get(rel);
	if (res.status >= 400) throw new Error(`Failed to load ${rel}: ${res.status}`);
	const $ = cheerio.load(res.data);
	let totalPages = 1;
	const pageLinks = $('a.page, .pagination a');
	pageLinks.each((_, a) => {
		const num = parseInt($(a).text().trim(), 10);
		if (!isNaN(num)) totalPages = Math.max(totalPages, num);
	});
	return { firstHtml: res.data, totalPages, rel };
}

function buildThreadPagePath(rel, pageNumber) {
	if (pageNumber === 1) return rel;
	return rel.includes('?') ? `${rel}&page=${pageNumber}` : `${rel}?page=${pageNumber}`;
}

function parseCommentsFromPage(html, currentPath) {
	const $ = cheerio.load(html);
	const comments = [];
	const seen = new Set();

	function pushUnique(body, hrefCandidate, el) {
		if (!body) return;
		let href = hrefCandidate;
		if (!href) {
			const anchorEl = $(el).find('a, .permalink a, a.permalink').filter((_, a) => (a.attribs?.href || '').includes('#'));
			href = anchorEl.attr('href');
		}
		if (!href) {
			const id = $(el).attr('id');
			if (id) href = `${currentPath}#${id}`;
		}
		const commentUrl = normalizeUrl(href || currentPath);
		const key = `${commentUrl}\n${body}`;
		if (!seen.has(key)) {
			seen.add(key);
			comments.push({ body, url: commentUrl });
		}
	}

	// Preferred specific structure
	$('article.uvUserAction.uvUserAction-comment').each((_, el) => {
		const body = textContent($(el).find('.uvUserActionBody').first());
		const href = $(el).find('a.permalink, .permalink a').attr('href');
		pushUnique(body, href, el);
	});

	// Fallback broader selectors
	$('.comment, .uvComment, .comment_item, [class*="comment"], .idea-comment').each((_, el) => {
		const body = textContent($(el).find('.body, .content, .uvCommentBody').first());
		pushUnique(body, undefined, el);
	});
	return comments;
}

async function extractRelevantComments(cookie, threads, queryCtx, sinceTs, onEvent, onProgress) {
	const client = createClient(cookie);
	const relevant = [];
	const threadConcurrency = Number(process.env.THREADS_CONCURRENCY || 2);
	const pageConcurrency = Number(process.env.COMMENTS_PAGE_CONCURRENCY || 3);

	let processedThreads = 0;
	let scannedComments = 0;
	const queue = [...threads];
	// Avoid emitting the same exact comment twice within a single extraction job
	const emittedCommentUrls = new Set();

	function buildRelaxedCtx(ctx) {
		// Relax: move must terms into optional
		const optional = Array.from(new Set([...(ctx.optional || []), ...(ctx.must || [])]));
		return { ...ctx, must: [], optional };
	}

	async function processThread(t) {
		const { firstHtml, totalPages, rel } = await discoverThreadPagination(client, t.url);
		const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
		let pagesProcessed = 0;
		let threadCommentsTotal = 0;
		let threadMatches = 0;

		async function processPage(pageNumber) {
			const path = buildThreadPagePath(rel, pageNumber);
			const html = pageNumber === 1 ? firstHtml : (await client.get(path)).data;
			const comments = parseCommentsFromPage(html, path);
			for (const c of comments) {
				try {
					// Try with comment text alone
					let res = await matchItem(c.body, queryCtx);
					// If not matched, try with relaxed context
					if (!res.isMatch && (queryCtx.must || []).length) {
						const relaxed = buildRelaxedCtx(queryCtx);
						res = await matchItem(c.body, relaxed);
					}
					// If still not matched, try augmenting with thread title for context
					if (!res.isMatch) {
						res = await matchItem(`${t.title} ${c.body}`, queryCtx);
					}
					if (res.isMatch) {
						const item = { ...c, threadTitle: t.title, threadUrl: t.url, _why: res.why };
						if (!emittedCommentUrls.has(item.url)) {
							emittedCommentUrls.add(item.url);
							relevant.push(item);
							onEvent?.({ type: 'comment', data: item });
							threadMatches += 1;
						}
					}
				} catch (_) {}
			}
			threadCommentsTotal += comments.length;
			scannedComments += comments.length;
			pagesProcessed += 1;
			onProgress?.({ threadIndex: processedThreads + 1, pageIndex: pagesProcessed, totalPages, totalRelevant: relevant.length, scannedComments });
		}

		let idx = 0;
		const workers = Array.from({ length: Math.min(pageConcurrency, pages.length) }, async () => {
			while (idx < pages.length) {
				const current = pages[idx++];
				await processPage(current);
			}
		});
		await Promise.all(workers);

		// Emit per-thread status events
		if (threadCommentsTotal === 0) {
			onEvent?.({ type: 'threadNoComments', data: { threadTitle: t.title, threadUrl: t.url } });
		} else if (threadMatches === 0) {
			onEvent?.({ type: 'threadNoMatches', data: { threadTitle: t.title, threadUrl: t.url } });
		}

		processedThreads += 1;
	}

	const workers = Array.from({ length: Math.min(threadConcurrency, queue.length) }, async () => {
		while (queue.length) {
			const t = queue.shift();
			await processThread(t);
		}
	});
	await Promise.all(workers);
	return relevant;
}

module.exports = { findRelevantThreads, extractRelevantComments };
