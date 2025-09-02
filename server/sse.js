function initSSE(res) {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders?.();

	const send = (event, data) => {
		const payload = typeof data === 'string' ? data : JSON.stringify(data);
		res.write(`event: ${event}\n`);
		res.write(`data: ${payload}\n\n`);
	};

	const keepAlive = setInterval(() => {
		res.write(': keep-alive\n\n');
	}, 25000);

	const end = () => {
		clearInterval(keepAlive);
		res.end();
	};

	return { send, end };
}

module.exports = { initSSE };


