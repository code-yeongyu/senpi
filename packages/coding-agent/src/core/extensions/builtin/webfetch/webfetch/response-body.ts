export interface ResponseBodyStream extends AsyncIterable<unknown> {
	on?(event: "error", listener: (error: Error) => void): unknown;
	destroy(error?: Error): void;
	dump?(options?: { limit: number; signal?: AbortSignal }): Promise<void>;
}

export async function discardBody(body: ResponseBodyStream, maxBytes: number, signal?: AbortSignal): Promise<void> {
	body.on?.("error", () => {});
	try {
		if (typeof body.dump === "function") {
			await body.dump(signal ? { limit: 1024, signal } : { limit: 1024 });
			return;
		}
		await drainBody(body, maxBytes, signal);
	} catch {
		// no-excuse-ok: catch - discard failures are not actionable for the caller.
	} finally {
		body.destroy();
	}
}

async function drainBody(body: ResponseBodyStream, maxBytes: number, signal?: AbortSignal): Promise<void> {
	let drained = 0;
	const iterator = body[Symbol.asyncIterator]();
	while (true) {
		const result = await nextChunk(iterator, signal);
		if (!result || result.done) return;
		drained += toUint8Array(result.value).length;
		if (drained > maxBytes) return;
	}
}

async function nextChunk(
	iterator: AsyncIterator<unknown>,
	signal?: AbortSignal,
): Promise<IteratorResult<unknown> | undefined> {
	if (!signal) return iterator.next();
	if (signal.aborted) return undefined;

	let resolveAbort: () => void = () => {};
	const aborted = new Promise<undefined>((resolve) => {
		resolveAbort = () => resolve(undefined);
	});
	const onAbort = (): void => resolveAbort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([iterator.next(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function toUint8Array(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	if (typeof chunk === "string") return new TextEncoder().encode(chunk);
	throw new Error("Unexpected response body chunk");
}
