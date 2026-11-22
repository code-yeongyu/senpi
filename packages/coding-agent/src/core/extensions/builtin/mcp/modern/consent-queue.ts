import { McpMrtrError } from "./errors.ts";

interface QueueJob {
	readonly signal: AbortSignal;
	readonly run: () => Promise<void>;
	readonly reject: (error: unknown) => void;
	abort: () => void;
}
const queues = new WeakMap<object, { busy: boolean; jobs: QueueJob[] }>();
export function queuedForm<T>(binding: object, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
	let queue = queues.get(binding);
	if (!queue) {
		queue = { busy: false, jobs: [] };
		queues.set(binding, queue);
	}
	const current = queue;
	const pump = () => {
		if (current.busy) return;
		const next = current.jobs.shift();
		if (!next) {
			queues.delete(binding);
			return;
		}
		next.signal.removeEventListener("abort", next.abort);
		if (next.signal.aborted) {
			next.reject(new McpMrtrError("MCP_MRTR_PROCESSING_UNAVAILABLE"));
			pump();
			return;
		}
		current.busy = true;
		void next.run().finally(() => {
			current.busy = false;
			pump();
		});
	};
	return new Promise((resolve, reject) => {
		const job: QueueJob = {
			signal,
			run: async () => {
				try {
					resolve(await run());
				} catch (error) {
					reject(error);
				}
			},
			reject,
			abort: () => {},
		};
		job.abort = () => {
			const index = current.jobs.indexOf(job);
			if (index >= 0) {
				current.jobs.splice(index, 1);
				signal.removeEventListener("abort", job.abort);
				reject(new McpMrtrError("MCP_MRTR_PROCESSING_UNAVAILABLE"));
				pump();
			}
		};
		current.jobs.push(job);
		signal.addEventListener("abort", job.abort, { once: true });
		if (signal.aborted) job.abort();
		pump();
	});
}
