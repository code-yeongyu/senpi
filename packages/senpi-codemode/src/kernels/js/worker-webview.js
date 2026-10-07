import { onCellRelease } from "./cell-run-context.js";
import { DELIVER_EVENT, WebViewPortClient, webViewError } from "./worker-webview-client.js";

// Bun constructs "chrome"-backend WebViews only on the process main thread, and this kernel runs in
// a worker where `globalThis.Bun` and `Bun.WebView` are non-writable. Cells therefore run with a
// `Bun` parameter bound to a stand-in whose `WebView` forwards Chrome-backed views to the
// main-thread service over a private port; every other `Bun.*` member is the real one.
const KERNEL_BUN = Symbol.for("senpi.kernel.bun");
const KERNEL_PROCESS_MODE = Symbol.for("senpi.kernel.processMode");

export function bindKernelBun(source) {
	if (!globalThis[KERNEL_BUN]) return source;
	return `((Bun) => ${source})(globalThis[Symbol.for("senpi.kernel.bun")])`;
}

export function installKernelWebView(requestPort) {
	const bun = globalThis.Bun;
	if (typeof bun !== "object" || bun === null || typeof bun.WebView !== "function") return;
	globalThis[KERNEL_BUN] = shadowBun(bun, createKernelWebView(bun.WebView, requestPort));
}

export function markKernelProcessMode() {
	globalThis[KERNEL_PROCESS_MODE] = true;
}

function shadowBun(real, WebView) {
	return new Proxy(
		{},
		{
			get: (_target, key) => (key === "WebView" ? WebView : Reflect.get(real, key)),
			set: (_target, key, value) => Reflect.set(real, key, value),
			has: (_target, key) => key === "WebView" || Reflect.has(real, key),
			ownKeys: () => Reflect.ownKeys(real),
			getOwnPropertyDescriptor: (_target, key) => {
				if (key === "WebView") return { value: WebView, writable: false, enumerable: true, configurable: true };
				const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
				return descriptor && { ...descriptor, configurable: true };
			},
		},
	);
}

// The macOS default (WebKit) stays a native worker view: its host process serves any thread.
// A process-mode kernel already runs its cells on the child's main thread, so the native
// WebView constructs there directly and no MessagePort proxy is ever needed.
function needsMainThread(options) {
	if (globalThis[KERNEL_PROCESS_MODE]) return false;
	const backend = options?.backend;
	if (backend === undefined) return process.platform !== "darwin";
	return backend === "chrome" || (typeof backend === "object" && backend !== null && backend.type === "chrome");
}

function closedError(method) {
	const error = new Error(`Invalid state: WebView.${method}: view is closed`);
	error.code = "ERR_INVALID_STATE";
	return error;
}

function createKernelWebView(NativeWebView, requestPort) {
	let connecting = null;
	const proxied = new WeakSet();
	const live = new Set();
	const natives = new Set();
	const finalizer = new FinalizationRegistry(({ client, viewId }) => client.post({ kind: "close", viewId }));

	function connect() {
		if (!connecting) {
			const attempt = requestPort().then(port => new WebViewPortClient(port, () => (connecting = null)));
			attempt.catch(() => {
				if (connecting === attempt) connecting = null;
			});
			connecting = attempt;
		}
		return connecting;
	}

	class WebView extends EventTarget {
		static closeAll() {
			for (const view of [...live]) view.close();
			for (const ref of [...natives]) ref.deref()?.close();
			natives.clear();
		}

		static [Symbol.hasInstance](value) {
			return value instanceof NativeWebView || proxied.has(value);
		}

		#viewId = crypto.randomUUID();
		#state = { url: "", title: "", loading: false };
		#listening = new Set();
		#console;
		#ready;
		#closed = false;
		#forgetRelease;
		onNavigated = null;
		onNavigationFailed = null;

		constructor(options = {}) {
			if (!needsMainThread(options)) {
				const view = new NativeWebView(options);
				const ref = new WeakRef(view);
				natives.add(ref);
				onCellRelease(() => ref.deref()?.close());
				return view;
			}
			super();
			const { console: capture, ...rest } = options;
			this.#console = capture;
			proxied.add(this);
			live.add(this);
			this.#forgetRelease = onCellRelease(() => this.close());
			const viewId = this.#viewId;
			this.#ready = connect().then(async client => {
				client.register(viewId, this);
				finalizer.register(this, { client, viewId }, this);
				const reply = await client.request({ kind: "create", viewId, options: rest, captureConsole: capture !== undefined });
				this.#apply(reply.state);
				return client;
			});
			this.#ready.catch(() => {});
		}

		get url() {
			return this.#state.url;
		}

		get title() {
			return this.#state.title;
		}

		get loading() {
			return this.#state.loading;
		}

		navigate(url) { return this.#call("navigate", [url]); }
		evaluate(script) { return this.#call("evaluate", [script]); }
		click(...args) { return this.#call("click", args); }
		type(text) { return this.#call("type", [text]); }
		press(...args) { return this.#call("press", args); }
		scroll(dx, dy) { return this.#call("scroll", [dx, dy]); }
		scrollTo(...args) { return this.#call("scrollTo", args); }
		resize(width, height) { return this.#call("resize", [width, height]); }
		back() { return this.#call("back", []); }
		forward() { return this.#call("forward", []); }
		reload() { return this.#call("reload", []); }
		cdp(...args) { return this.#call("cdp", args); }

		async screenshot(options) {
			const value = await this.#call("screenshot", [options]);
			if (options?.encoding === "buffer" && value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			return value;
		}

		addEventListener(type, listener, options) {
			super.addEventListener(type, listener, options);
			if (this.#closed || this.#listening.has(type)) return;
			this.#listening.add(type);
			const viewId = this.#viewId;
			this.#ready.then(client => client.post({ kind: "listen", viewId, event: type }), () => {});
		}

		close() {
			if (this.#closed) return;
			this.#closed = true;
			this.#forgetRelease?.();
			live.delete(this);
			const viewId = this.#viewId;
			this.#ready.then(
				client => {
					client.post({ kind: "close", viewId });
					client.forget(viewId);
					finalizer.unregister(this);
				},
				() => {},
			);
		}

		[Symbol.dispose]() {
			this.close();
		}

		[Symbol.asyncDispose]() {
			this.close();
		}

		[DELIVER_EVENT](event) {
			if (event.type === "console") {
				const [type, ...args] = event.args;
				if (typeof this.#console === "function") this.#console(type, ...args);
				else this.#console?.[type]?.(...args);
			} else if (event.type === "navigated") {
				this.#state = { ...this.#state, url: event.url, title: event.title };
				this.onNavigated?.(event.url, event.title);
			} else if (event.type === "navigation-failed") {
				this.onNavigationFailed?.(webViewError(event.error));
			} else if (event.type === "dom") {
				this.dispatchEvent(new MessageEvent(event.name, { data: event.data }));
			}
		}

		async #call(method, args) {
			if (this.#closed) throw closedError(method);
			const client = await this.#ready;
			if (this.#closed) throw closedError(method);
			const trimmed = [...args];
			while (trimmed.length > 0 && trimmed.at(-1) === undefined) trimmed.pop();
			const reply = await client.request({ kind: "call", viewId: this.#viewId, method, args: trimmed });
			this.#apply(reply.state);
			return reply.value;
		}

		#apply(state) {
			if (state) this.#state = state;
		}
	}

	return WebView;
}
