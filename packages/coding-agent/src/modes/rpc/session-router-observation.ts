import type { RouterContext } from "./session-router-context.ts";

/** The row's heap split: zeros until the view is installed, and for a session holding no kernel. */
export function sessionMemory(
	host: RouterContext,
	sessionId: string,
): {
	main_heap_bytes: number;
	kernel_heap_bytes: number;
	kernel_count: number;
} {
	const view = host.hostMemoryView;
	if (view === undefined) return { main_heap_bytes: 0, kernel_heap_bytes: 0, kernel_count: 0 };
	const kernels = view.kernels().filter((kernel) => kernel.sessionId === sessionId);
	let kernelHeapBytes = 0;
	for (const kernel of kernels) kernelHeapBytes += kernel.liveBytes;
	return {
		main_heap_bytes: view.mainHeapBytes(),
		kernel_heap_bytes: kernelHeapBytes,
		kernel_count: kernels.length,
	};
}

export function acknowledgePrompt(host: RouterContext, id: string | undefined, sessionId: string): void {
	const connection = host.writer.currentConnection();
	if (id === undefined || connection === undefined) return;
	const inFlight = Math.max(0, (host.activeRequests.get(sessionId) ?? 1) - 1);
	host.writer.sendOpenQueued(connection, {
		type: "queued",
		for_request: id,
		position: inFlight + 1,
		in_flight: inFlight,
	});
}

/** Resolves once the only request in flight for `sessionId` is the caller's own. */
export function otherRequestsSettled(host: RouterContext, sessionId: string): Promise<void> {
	return new Promise((resolve) => {
		const listeners = host.requestSettledListeners.get(sessionId) ?? new Set<() => void>();
		const check = (): void => {
			if ((host.activeRequests.get(sessionId) ?? 0) > 1) return;
			listeners.delete(check);
			if (listeners.size === 0) host.requestSettledListeners.delete(sessionId);
			resolve();
		};
		listeners.add(check);
		host.requestSettledListeners.set(sessionId, listeners);
		check();
	});
}
