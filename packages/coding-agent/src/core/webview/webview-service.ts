import { randomUUID } from "node:crypto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { retireBunChrome, settleDeadBunChrome } from "./bun-chrome.ts";
import { mainThreadWebViewClass, type NativeWebView, type NativeWebViewClass } from "./native-webview.ts";
import { closeQuietly, WebViewServiceClient } from "./webview-client.ts";
import {
	type AttachDeadline,
	attachedWithin,
	DEFAULT_READINESS,
	type ReadinessEvent,
	readinessLogFromEnvironment,
	timedDeadline,
	WebViewNotReadyError,
	type WebViewReadinessPolicy,
} from "./webview-readiness.ts";

export interface WebViewServiceOptions {
	readonly readiness?: Partial<WebViewReadinessPolicy>;
	readonly onReadiness?: (event: ReadinessEvent) => void;
	/** The readiness bound of each launch; defaults to `attachBoundMs`. Tests signal it instead of waiting. */
	readonly attachDeadline?: (launch: number) => AttachDeadline;
}

export interface WebViewClientGrant {
	readonly clientId: string;
	readonly port: MessagePort;
}

/**
 * Serves Chrome-backed `Bun.WebView`s on the process main thread (Bun allows that backend nowhere
 * else) for eval kernels running in worker threads. Every kernel gets its own client: a private
 * MessagePort plus the views created through it, released as a unit by the owner that asked.
 */
export class WebViewService {
	readonly #webViewClass: NativeWebViewClass;
	readonly #readiness: WebViewReadinessPolicy;
	readonly #onReadiness: (event: ReadinessEvent) => void;
	readonly #attachDeadline: (launch: number) => AttachDeadline;
	readonly #clients = new Map<string, WebViewServiceClient>();
	#retiring: Promise<void> = Promise.resolve();
	#chromeInUse = false;
	// Views being constructed and not yet adopted by their client: Chrome must outlive them.
	#launching = 0;

	constructor(webViewClass: NativeWebViewClass, options: WebViewServiceOptions = {}) {
		this.#webViewClass = webViewClass;
		this.#readiness = { ...DEFAULT_READINESS, ...options.readiness };
		this.#onReadiness = options.onReadiness ?? (() => {});
		const boundMs = this.#readiness.attachBoundMs;
		this.#attachDeadline = options.attachDeadline ?? (() => timedDeadline(boundMs));
	}

	get viewCount(): number {
		let count = 0;
		for (const client of this.#clients.values()) count += client.viewCount;
		return count;
	}

	connect(owner: object): WebViewClientGrant {
		const clientId = randomUUID();
		const channel = new MessageChannel();
		const client = new WebViewServiceClient(clientId, owner, channel.port1, {
			createView: (options, onConsole, adopt, wanted) => this.#createView(options, onConsole, adopt, wanted),
			onClientClosed: (closed) => void this.#drop(closed),
		});
		this.#clients.set(clientId, client);
		return { clientId, port: channel.port2 };
	}

	/**
	 * Only the owner that connected a client can release it. Resolves after the client's in-flight
	 * launches settled and any Chrome retirement in flight ended, including one a closed port (the
	 * client's worker died first) already started.
	 */
	async release(clientId: string, owner: object): Promise<void> {
		const client = this.#clients.get(clientId);
		if (client?.owner === owner) await this.#drop(client);
		await this.#retiring;
	}

	async releaseOwner(owner: object): Promise<void> {
		const owned = [...this.#clients.values()].filter((client) => client.owner === owner);
		await Promise.all(owned.map((client) => this.#drop(client)));
		await this.#retiring;
	}

	/**
	 * Launches a view, waits until it is ready, and hands it to `adopt` in the same turn, so no
	 * retirement can slip between the launch and the client's bookkeeping. A launch that fails, never
	 * becomes ready, or whose client was released while it was in flight, retires the Chrome it started
	 * unless another view still needs it; a launch that never became ready is retried once on a fresh
	 * Chrome before the create fails naming the phase it stalled in.
	 */
	async #createView(
		options: Readonly<Record<string, unknown>>,
		onConsole: ((...args: unknown[]) => void) | undefined,
		adopt: (view: NativeWebView) => boolean,
		wanted: () => boolean,
	): Promise<NativeWebView> {
		const viewOptions = onConsole ? { ...options, console: onConsole } : options;
		for (let launch = 1; ; launch++) {
			this.#launching++;
			let view: NativeWebView | undefined;
			try {
				view = await this.#launchReady(viewOptions, launch);
			} catch (error) {
				this.#launching--;
				await this.#retireIfIdle();
				throw error;
			}
			this.#launching--;
			if (view) {
				if (adopt(view)) return view;
				closeQuietly(view);
				await this.#retireIfIdle();
				throw new Error("WebView client released");
			}
			await this.#retireIfIdle();
			if (!wanted()) throw new Error("WebView client released");
			if (launch >= this.#readiness.launchAttempts) throw new WebViewNotReadyError(launch, this.#readiness);
		}
	}

	/** A launched view whose readiness navigation settled, or undefined (the view closed) when it stalled. */
	async #launchReady(
		viewOptions: Readonly<Record<string, unknown>>,
		launch: number,
	): Promise<NativeWebView | undefined> {
		const view = await this.#launch(viewOptions);
		let attachMs: number | undefined;
		try {
			attachMs = await attachedWithin(view, this.#attachDeadline(launch));
		} catch (error) {
			closeQuietly(view);
			throw error;
		}
		if (attachMs !== undefined) {
			this.#onReadiness({ type: "ready", launch, attachMs });
			return view;
		}
		closeQuietly(view);
		this.#onReadiness({ type: "stalled", phase: "cdp-target-attach", launch });
		return undefined;
	}

	async #launch(viewOptions: Readonly<Record<string, unknown>>): Promise<NativeWebView> {
		// No retirement is scheduled while a launch is pending, so the one awaited here is the last.
		await this.#retiring;
		await settleDeadBunChrome();
		this.#chromeInUse = true;
		for (let attempt = 1; ; attempt++) {
			try {
				return new this.#webViewClass(viewOptions);
			} catch (error) {
				if (!isChromeRelaunchWindow(error) || attempt >= RELAUNCH_ATTEMPTS) throw error;
				await new Promise((resolve) => setTimeout(resolve, RELAUNCH_RETRY_MS));
			}
		}
	}

	async #drop(client: WebViewServiceClient): Promise<void> {
		if (this.#clients.get(client.id) !== client) return await this.#retiring;
		this.#clients.delete(client.id);
		client.release();
		await client.settled();
		await this.#retireIfIdle();
	}

	/** Retires Chrome once no view uses it and no launch is pending; resolves when retirement ends. */
	#retireIfIdle(): Promise<void> {
		if (!this.#chromeInUse || this.#busy()) return this.#retiring;
		this.#chromeInUse = false;
		this.#retiring = this.#retiring.then(() => (this.#busy() ? undefined : retireBunChrome(this.#webViewClass)));
		return this.#retiring;
	}

	#busy(): boolean {
		return this.viewCount > 0 || this.#launching > 0;
	}
}

// Right after Chrome dies, Windows refuses to relaunch it for about a second (Bun reports
// ERR_DLOPEN_FAILED "Failed to spawn Chrome"); a missing Chrome fails the same way, so the
// retry is bounded and the last error is surfaced.
const RELAUNCH_ATTEMPTS = 8;
const RELAUNCH_RETRY_MS = 250;

function isChromeRelaunchWindow(error: unknown): boolean {
	return error instanceof Error && Reflect.get(error, "code") === "ERR_DLOPEN_FAILED";
}

const SERVICE_KEY = Symbol.for("senpi.webview.service");

function isWebViewService(value: unknown): value is WebViewService {
	return value instanceof WebViewService;
}

/** The process-wide service, created on first use; undefined off the main thread or without `Bun.WebView`. */
export function mainThreadWebViewService(): WebViewService | undefined {
	const existing: unknown = Reflect.get(globalThis, SERVICE_KEY);
	if (isWebViewService(existing)) return existing;
	const webViewClass = mainThreadWebViewClass();
	if (!webViewClass) return undefined;
	const onReadiness = readinessLogFromEnvironment();
	const service = new WebViewService(webViewClass, onReadiness ? { onReadiness } : {});
	Reflect.set(globalThis, SERVICE_KEY, service);
	return service;
}
