/** Tap the raw body of streaming SDK requests before the SDK discards SSE comments. */
export function withTransportActivity(
	fetch: typeof globalThis.fetch | undefined,
	onActivity: (() => void) | undefined,
): typeof globalThis.fetch | undefined {
	if (!onActivity) return fetch;
	const baseFetch = fetch ?? globalThis.fetch;
	return async (input, init) => {
		const response = await baseFetch(input, init);
		if (!response.ok || !response.body) return response;

		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					if (chunk.byteLength > 0) onActivity();
					controller.enqueue(chunk);
				},
			}),
		);
		return Object.defineProperties(new Response(body, response), {
			url: { value: response.url },
			redirected: { value: response.redirected },
			type: { value: response.type },
		});
	};
}
