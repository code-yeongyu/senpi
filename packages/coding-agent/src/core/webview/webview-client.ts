import type { MessagePort } from "node:worker_threads";
import type { NativeWebView } from "./native-webview.ts";
import {
	type ClientToService,
	parseClientMessage,
	type ServiceToClient,
	type WebViewEvent,
	type WebViewState,
	wireError,
} from "./webview-wire.ts";

export interface WebViewClientHost {
	/**
	 * Launches a view; `adopt` runs in the launch's own turn and returns false once the client is released,
	 * and `wanted` tells a launch about to be retried whether anyone still waits for it.
	 */
	createView(
		options: Readonly<Record<string, unknown>>,
		onConsole: ((...args: unknown[]) => void) | undefined,
		adopt: (view: NativeWebView) => boolean,
		wanted: () => boolean,
	): Promise<NativeWebView>;
	onClientClosed(client: WebViewServiceClient): void;
}

function stateOf(view: NativeWebView): WebViewState {
	return { url: view.url, title: view.title, loading: view.loading };
}

export function closeQuietly(view: NativeWebView): void {
	try {
		view.close();
	} catch {
		// A view whose browser already died has nothing left to close.
	}
}

/**
 * One kernel's capability: the views it created and the only port that can reach them. Nothing is
 * addressable across clients, so one session's cell cannot see, drive, or close another's views.
 */
export class WebViewServiceClient {
	readonly id: string;
	readonly owner: object;
	readonly #port: MessagePort;
	readonly #host: WebViewClientHost;
	readonly #views = new Map<string, NativeWebView>();
	readonly #launches = new Set<Promise<NativeWebView>>();
	#released = false;

	constructor(id: string, owner: object, port: MessagePort, host: WebViewClientHost) {
		this.id = id;
		this.owner = owner;
		this.#port = port;
		this.#host = host;
		port.on("message", (message: unknown) => void this.#handle(parseClientMessage(message)));
		port.on("close", () => this.#host.onClientClosed(this));
		port.unref();
	}

	get viewCount(): number {
		return this.#views.size;
	}

	/** Resolves once every launch this client started has been adopted or has retired its Chrome. */
	async settled(): Promise<void> {
		await Promise.allSettled([...this.#launches]);
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		for (const view of this.#views.values()) closeQuietly(view);
		this.#views.clear();
		this.#port.close();
	}

	async #handle(message: ClientToService | undefined): Promise<void> {
		if (!message || this.#released) return;
		switch (message.kind) {
			case "create":
				await this.#reply(message.id, async () => {
					const view = await this.#create(message.viewId, message.options, message.captureConsole);
					return { value: undefined, view };
				});
				return;
			case "call":
				await this.#reply(message.id, async () => {
					const view = this.#view(message.viewId);
					const method: unknown = Reflect.get(view, message.method);
					if (typeof method !== "function") throw new TypeError(`WebView.${message.method} is not available`);
					const value: unknown = await Reflect.apply(method, view, [...message.args]);
					return { value, view };
				});
				return;
			case "close": {
				const view = this.#views.get(message.viewId);
				this.#views.delete(message.viewId);
				if (view) closeQuietly(view);
				return;
			}
			case "listen": {
				const view = this.#views.get(message.viewId);
				view?.addEventListener(message.event, (event) => {
					const data: unknown = Reflect.get(event, "data");
					this.#emit(message.viewId, { type: "dom", name: message.event, data });
				});
				return;
			}
			case "close-all":
				for (const view of this.#views.values()) closeQuietly(view);
				this.#views.clear();
				this.#post({ kind: "reply", id: message.id, ok: true, value: undefined });
				return;
		}
	}

	async #create(
		viewId: string,
		options: Readonly<Record<string, unknown>>,
		captureConsole: boolean,
	): Promise<NativeWebView> {
		if (this.#views.has(viewId)) throw new Error(`WebView ${viewId} already exists`);
		const onConsole = captureConsole
			? (...args: unknown[]) => this.#emit(viewId, { type: "console", args })
			: undefined;
		const launch = this.#host.createView(
			options,
			onConsole,
			(view) => this.#adopt(viewId, view),
			() => !this.#released,
		);
		this.#launches.add(launch);
		try {
			return await launch;
		} finally {
			this.#launches.delete(launch);
		}
	}

	#adopt(viewId: string, view: NativeWebView): boolean {
		if (this.#released) return false;
		view.onNavigated = (url, title) => this.#emit(viewId, { type: "navigated", url, title });
		view.onNavigationFailed = (error) => this.#emit(viewId, { type: "navigation-failed", error: wireError(error) });
		this.#views.set(viewId, view);
		return true;
	}

	#view(viewId: string): NativeWebView {
		const view = this.#views.get(viewId);
		if (view) return view;
		const error = new Error(`Unknown WebView ${viewId}: it was closed or belongs to another kernel`);
		Reflect.set(error, "code", "ERR_INVALID_STATE");
		throw error;
	}

	async #reply(id: number, work: () => Promise<{ value: unknown; view: NativeWebView }>): Promise<void> {
		try {
			const { value, view } = await work();
			this.#post({ kind: "reply", id, ok: true, value, state: stateOf(view) });
		} catch (error) {
			this.#post({ kind: "reply", id, ok: false, error: wireError(error) });
		}
	}

	#emit(viewId: string, event: WebViewEvent): void {
		this.#post({ kind: "event", viewId, event });
	}

	#post(message: ServiceToClient): void {
		if (this.#released) return;
		try {
			this.#port.postMessage(message);
		} catch (error) {
			if (message.kind !== "reply" || !message.ok) return;
			this.#port.postMessage({ kind: "reply", id: message.id, ok: false, error: wireError(error) });
		}
	}
}
