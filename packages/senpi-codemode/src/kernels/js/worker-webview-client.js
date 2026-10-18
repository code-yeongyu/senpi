// The kernel worker's end of its private port to the main-thread Bun.WebView service. Mirrors
// the message shapes in packages/coding-agent/src/core/webview/webview-wire.ts (this worker file
// cannot import TypeScript); keep the two in sync.

export const DELIVER_EVENT = Symbol("senpi.webview.deliver");

export function webViewError(wire) {
	const error = new Error(wire?.message ?? "Bun.WebView request failed");
	if (typeof wire?.name === "string") error.name = wire.name;
	if (typeof wire?.code === "string") error.code = wire.code;
	return error;
}

export class WebViewPortClient {
	#port;
	#pending = new Map();
	#views = new Map();
	#nextId = 1;
	#closed = false;
	#onClosed;

	constructor(port, onClosed) {
		this.#port = port;
		this.#onClosed = onClosed;
		port.on("message", message => this.#receive(message));
		port.on("close", () => this.#fail(new Error("Bun.WebView service connection closed")));
	}

	register(viewId, view) {
		this.#views.set(viewId, new WeakRef(view));
	}

	forget(viewId) {
		this.#views.delete(viewId);
	}

	request(message) {
		if (this.#closed) return Promise.reject(new Error("Bun.WebView service connection closed"));
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			try {
				this.#port.postMessage({ ...message, id });
			} catch (error) {
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	post(message) {
		if (this.#closed) return;
		try {
			this.#port.postMessage(message);
		} catch {
			// A closed port has already released every view on the service side.
		}
	}

	#receive(message) {
		if (message?.kind === "reply") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.ok) pending.resolve({ value: message.value, state: message.state });
			else pending.reject(webViewError(message.error));
			return;
		}
		if (message?.kind === "event") this.#views.get(message.viewId)?.deref()?.[DELIVER_EVENT](message.event);
	}

	#fail(error) {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#onClosed();
	}
}
