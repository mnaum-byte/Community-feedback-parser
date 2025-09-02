const { nanoid } = require('nanoid');

class JobManager {
	constructor() {
		this.jobs = new Map();
	}

	createJob(type, payload = {}) {
		const id = nanoid();
		const job = {
			id,
			type,
			status: 'pending',
			progress: 0,
			createdAt: Date.now(),
			payload,
			listeners: new Set(),
			cancelled: false,
		};
		this.jobs.set(id, job);
		return job;
	}

	getJob(id) {
		return this.jobs.get(id);
	}

	addListener(id, listener) {
		const job = this.getJob(id);
		if (!job) return false;
		job.listeners.add(listener);
		return true;
	}

	removeListener(id, listener) {
		const job = this.getJob(id);
		if (!job) return;
		job.listeners.delete(listener);
	}

	broadcast(id, event, data) {
		const job = this.getJob(id);
		if (!job) return;
		for (const listener of job.listeners) {
			listener(event, data);
		}
	}

	update(id, data) {
		const job = this.getJob(id);
		if (!job) return;
		Object.assign(job, data);
	}

	cancel(id) {
		const job = this.getJob(id);
		if (!job) return;
		job.cancelled = true;
	}
}

const jobManager = new JobManager();
module.exports = { jobManager };


