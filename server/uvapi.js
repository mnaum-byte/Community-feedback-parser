const axios = require('axios');

function getSubdomain() {
	return process.env.UV_SUBDOMAIN || 'adobeexpress';
}

function createApiClient(token) {
	const sub = getSubdomain();
	const baseURL = `https://${sub}.uservoice.com/api/v2`;
	const client = axios.create({
		baseURL,
		headers: { Authorization: `Bearer ${token}` },
		timeout: 30000,
	});
	return client;
}

async function paginate(client, path, params = {}, picker = (r) => r) {
	let page = 1;
	const perPage = 100;
	const out = [];
	for (;;) {
		const res = await client.get(path, { params: { ...params, page, per_page: perPage } });
		const data = res.data || {};
		const chunk = picker(data) || [];
		out.push(...chunk);
		if (!chunk.length || (data.pagination && (data.pagination.page >= data.pagination.total_pages))) break;
		page += 1;
	}
	return out;
}

function mapSuggestionToThread(s) {
	const sub = getSubdomain();
	const url = s && s.id ? `https://${sub}.uservoice.com/suggestions/${s.id}` : `https://${sub}.uservoice.com`;
	return {
		title: s.title || '',
		description: s.text || s.description || '',
		url,
		id: s.id,
		updated_at: s.updated_at || s.updatedAt || null,
	};
}

async function listSuggestionsUpdatedSince(client, sinceIso) {
	const items = await paginate(client, '/suggestions', { updated_after: sinceIso }, (d) => d.suggestions || d.items || []);
	return items.map(mapSuggestionToThread);
}

async function listCommentsForSuggestion(client, suggestionId) {
	const items = await paginate(client, '/comments', { suggestion: suggestionId }, (d) => d.comments || d.items || []);
	return items.map((c) => ({
		id: c.id,
		body: c.text || c.body || '',
		url: c.html_url || c.url || '',
		created_at: c.created_at || c.createdAt || null,
	}));
}

module.exports = { createApiClient, listSuggestionsUpdatedSince, listCommentsForSuggestion };
