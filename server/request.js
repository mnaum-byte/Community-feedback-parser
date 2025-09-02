const axios = require('axios');

const BASE_URL = 'https://adobeexpress.uservoice.com';

function createClient(cookie) {
	const instance = axios.create({
		baseURL: BASE_URL,
		headers: {
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
			'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9',
			'Cookie': cookie || '',
		},
		timeout: Number(process.env.HTTP_TIMEOUT_MS || 20000),
		validateStatus: status => status < 500,
	});

	instance.interceptors.response.use(async (res) => {
		if (res.status === 403 || res.status === 401) {
			throw new Error('Authentication failed. Please provide a valid cookie.');
		}
		return res;
	});

	// Basic retry with backoff for transient errors
	instance.interceptors.response.use(undefined, async (error) => {
		const config = error.config || {};
		config.__retryCount = config.__retryCount || 0;
		const maxRetries = 3;
		if (config.__retryCount >= maxRetries) throw error;
		config.__retryCount += 1;
		const delayMs = 500 * Math.pow(2, config.__retryCount);
		await new Promise(r => setTimeout(r, delayMs));
		return instance.request(config);
	});

	return instance;
}

module.exports = { createClient, BASE_URL };


