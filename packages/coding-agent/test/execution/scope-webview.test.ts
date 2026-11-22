// Brain/hand split plan row S16e (Z2.ISO.e): WebViews belong to the execution scope that created them, so
// one runtime serving several scopes can end one scope's views and leave the others' open.
import type { MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NativeWebView, NativeWebViewClass } from "../../src/core/webview/native-webview.ts";
import {
	connectWebViewService,
	createWebViewBroker,
	releaseWebViewScope,
	type WebViewBroker,
} from "../../src/core/webview/webview-broker.ts";
import { WebViewService } from "../../src/core/webview/webview-service.ts";

const SERVICE_KEY = Symbol.for("senpi.webview.service");
const openViews = new Set<FakeView>();

// A view whose readiness navigation settles at once: no real Chrome is involved.
class FakeView extends EventTarget implements NativeWebView {
	url = "about:blank";
	title = "";
	loading = false;
	onNavigated: ((url: string, title: string) => void) | null = null;
	onNavigationFailed: ((error: Error) => void) | null = null;
	navigate(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {
		openViews.delete(this);
	}
}

const FakeViewClass: NativeWebViewClass = Object.assign(
	class extends FakeView {
		constructor(_options: Readonly<Record<string, unknown>>) {
			super();
			openViews.add(this);
		}
	},
	{ closeAll: () => {} },
);

type Reply = { readonly kind: "reply"; readonly id: number; readonly ok: boolean };

let nextId = 1;
function request(port: MessagePort, message: Record<string, unknown>): Promise<Reply> {
	const id = nextId++;
	return new Promise((resolve) => {
		const onMessage = (reply: Reply): void => {
			if (reply.kind !== "reply" || reply.id !== id) return;
			port.off("message", onMessage);
			resolve(reply);
		};
		port.on("message", onMessage);
		port.postMessage({ ...message, id });
	});
}

function createView(port: MessagePort, viewId: string): Promise<Reply> {
	return request(port, { kind: "create", viewId, options: { backend: "chrome" }, captureConsole: false });
}

function navigate(port: MessagePort, viewId: string): Promise<Reply> {
	return request(port, { kind: "call", viewId, method: "navigate", args: ["about:blank"] });
}

type BrokerReply = {
	readonly id: number;
	readonly kind: string;
	readonly clientId?: string;
	readonly port?: MessagePort;
};

// Speaks the broker protocol exactly as a worker thread's broker client does.
function brokerSide(broker: WebViewBroker): (message: Record<string, unknown>) => Promise<BrokerReply> {
	let id = 1;
	return (message) =>
		new Promise((resolve) => {
			const requestId = id++;
			const onMessage = (reply: BrokerReply): void => {
				if (reply.id !== requestId) return;
				broker.port.off("message", onMessage);
				resolve(reply);
			};
			broker.port.on("message", onMessage);
			broker.port.postMessage({ ...message, id: requestId });
		});
}

let service: WebViewService;
beforeEach(() => {
	service = new WebViewService(FakeViewClass, {
		attachDeadline: () => ({ reached: new Promise(() => {}), cancel: () => {} }),
		retireChrome: async () => {},
	});
	Reflect.set(globalThis, SERVICE_KEY, service);
});
afterEach(() => {
	Reflect.deleteProperty(globalThis, SERVICE_KEY);
	openViews.clear();
});

describe("WebViews are scoped per execution scope (S16e)", () => {
	it("MULTI: ending one scope closes only its views on the main-thread route", async () => {
		// Given scopes A and B each opened a view through the same service.
		const a = await connectWebViewService("A");
		const b = await connectWebViewService("B");
		expect(await createView(a.port, "a1")).toMatchObject({ ok: true });
		expect(await createView(b.port, "b1")).toMatchObject({ ok: true });
		expect(service.viewCount).toBe(2);

		// When scope A ends.
		await releaseWebViewScope("A");

		// Then A's view is closed and B's is still open and usable.
		expect(service.viewCount).toBe(1);
		expect(openViews.size).toBe(1);
		expect(await navigate(b.port, "b1")).toMatchObject({ ok: true });
		await b.release();
		expect(service.viewCount).toBe(0);
	});

	it("MULTI: through one worker broker, a scope can release neither another scope's client nor its views", async () => {
		// Given one broker (one worker thread) serving scopes A and B, each with a view.
		const broker = createWebViewBroker();
		expect(broker).toBeDefined();
		if (broker === undefined) return;
		const send = brokerSide(broker);
		const a = await send({ kind: "connect", scope: "A" });
		const b = await send({ kind: "connect", scope: "B" });
		if (a.port === undefined || b.port === undefined) throw new Error("broker granted no port");
		expect(await createView(a.port, "a1")).toMatchObject({ ok: true });
		expect(await createView(b.port, "b1")).toMatchObject({ ok: true });

		// When scope A asks to release B's client, then A ends.
		await send({ kind: "release", clientId: b.clientId, scope: "A" });
		expect(service.viewCount).toBe(2);
		await send({ kind: "release-scope", scope: "A" });

		// Then only A's view closed; B's stays until the broker itself goes.
		expect(service.viewCount).toBe(1);
		expect(await navigate(b.port, "b1")).toMatchObject({ ok: true });
		await broker.dispose();
		expect(service.viewCount).toBe(0);
	});

	it("keeps unscoped connections as before: each is released on its own", async () => {
		// Given two unscoped connections, as every caller makes today.
		const first = await connectWebViewService();
		const second = await connectWebViewService();
		await createView(first.port, "v1");
		await createView(second.port, "v2");

		// When the first is released.
		await first.release();

		// Then the second's view is untouched.
		expect(service.viewCount).toBe(1);
		await second.release();
	});
});
