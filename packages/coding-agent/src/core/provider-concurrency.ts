import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";

interface Waiter {
	grant(): void;
}

interface ProviderSemaphore {
	limit: number;
	active: number;
	waiters: Waiter[];
}

/** Limit provider requests, not agent turns: tool execution must not retain a slot. */
export function createProviderSemaphores(getLimit: (providerId: string) => number) {
	const providers = new Map<string, ProviderSemaphore>();

	function drain(semaphore: ProviderSemaphore): void {
		while (semaphore.active < semaphore.limit && semaphore.waiters.length > 0) {
			semaphore.waiters.shift()?.grant();
		}
	}

	function resize(providerId: string, limit: number): void {
		const semaphore = providers.get(providerId);
		if (!semaphore) return;
		semaphore.limit = limit > 0 ? limit : Infinity;
		drain(semaphore);
	}

	function acquire(semaphore: ProviderSemaphore, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const abort = () => {
				const index = semaphore.waiters.indexOf(waiter);
				if (index !== -1) semaphore.waiters.splice(index, 1);
				reject(signal?.reason);
			};
			const waiter: Waiter = {
				grant() {
					signal?.removeEventListener("abort", abort);
					semaphore.active++;
					let released = false;
					resolve(() => {
						if (released) return;
						released = true;
						semaphore.active--;
						drain(semaphore);
					});
				},
			};
			semaphore.waiters.push(waiter);
			signal?.addEventListener("abort", abort, { once: true });
			drain(semaphore);
		});
	}

	async function runAcquired(
		semaphore: ProviderSemaphore,
		signal: AbortSignal | undefined,
		run: () => AssistantMessageEventStream,
	): Promise<AssistantMessageEventStream> {
		const release = await acquire(semaphore, signal);
		try {
			signal?.throwIfAborted();
			const stream = run();
			void stream.result().then(release, release);
			return stream;
		} catch (error) {
			release();
			throw error;
		}
	}

	return {
		resize,
		bracket(
			providerId: string,
			signal: AbortSignal | undefined,
			run: () => AssistantMessageEventStream,
		): AssistantMessageEventStream | Promise<AssistantMessageEventStream> {
			const configured = getLimit(providerId);
			const limit = configured > 0 ? configured : Infinity;
			resize(providerId, limit);
			if (limit === Infinity) return run();
			let semaphore = providers.get(providerId);
			if (!semaphore) {
				semaphore = { limit, active: 0, waiters: [] };
				providers.set(providerId, semaphore);
			}
			return runAcquired(semaphore, signal, run);
		},
	};
}
