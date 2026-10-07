import type { MessagePort } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { retireBunChrome } from "../../coding-agent/src/core/webview/bun-chrome.ts";
import { mainThreadWebViewClass, type NativeWebViewClass } from "../../coding-agent/src/core/webview/native-webview.ts";
import type { AttachDeadline, ReadinessEvent } from "../../coding-agent/src/core/webview/webview-readiness.ts";
import { type WebViewClientGrant, WebViewService } from "../../coding-agent/src/core/webview/webview-service.ts";
import {
	bunChromeChildren,
	bunWebViewAvailable,
	serveFixturePage,
	type WebViewFixturePage,
} from "./eval/webview-fixtures.ts";

// senpi#2353: on windows-latest a freshly launched Chrome sometimes never attaches the CDP session of
// a new view, so its first navigation never settled, the cell waited out its whole budget, and that
// Chrome outlived the test. The stall is injected by a first navigation that never settles.

type Reply = {
	readonly kind: "reply";
	readonly id: number;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: { readonly message: string; readonly code?: string };
};

let page: WebViewFixturePage | undefined;
const owner = {};
const grants: { service: WebViewService; grant: WebViewClientGrant }[] = [];

function nativeClass(): NativeWebViewClass {
	const native = mainThreadWebViewClass();
	if (!native) throw new Error("expected Bun.WebView on the main thread");
	return native;
}

interface StallingLaunches {
	readonly webViewClass: NativeWebViewClass;
	readonly attachDeadline: () => AttachDeadline;
	launches(): number;
}

/**
 * Real Chrome launches; the launches `stalls` picks never settle their first navigation. A launch's
 * readiness bound is reached the moment its stalled navigation starts, and never for a healthy one,
 * so no case depends on how fast a runner's Chrome attaches.
 */
function stallingLaunches(stalls: (launch: number) => boolean): StallingLaunches {
	let launches = 0;
	let current: (() => void) | undefined;
	const webViewClass = new Proxy(nativeClass(), {
		construct(target, args) {
			launches += 1;
			const view: object = Reflect.construct(target, args);
			if (stalls(launches)) {
				Object.defineProperty(view, "navigate", {
					value: () => {
						current?.();
						return new Promise(() => {});
					},
				});
			}
			return view;
		},
	});
	const attachDeadline = (): AttachDeadline => {
		const reached = Promise.withResolvers<void>();
		current = reached.resolve;
		return { reached: reached.promise, cancel: () => {} };
	};
	return { webViewClass, attachDeadline, launches: () => launches };
}

function connect(service: WebViewService): MessagePort {
	const grant = service.connect(owner);
	grants.push({ service, grant });
	return grant.port;
}

let nextId = 1;
function request(port: MessagePort, message: Readonly<Record<string, unknown>>): Promise<Reply> {
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

function fixtureUrl(): string {
	if (!page) throw new Error("fixture page is not running");
	return page.url;
}

const create = (port: MessagePort, viewId: string) =>
	request(port, { kind: "create", viewId, options: { backend: "chrome" }, captureConsole: false });

async function greetingAfterNavigate(port: MessagePort, viewId: string): Promise<unknown> {
	const navigated = await request(port, { kind: "call", viewId, method: "navigate", args: [fixtureUrl()] });
	expect(navigated).toMatchObject({ ok: true });
	const read = await request(port, {
		kind: "call",
		viewId,
		method: "evaluate",
		args: ["document.getElementById('greeting').textContent"],
	});
	return read.value;
}

describe.skipIf(!bunWebViewAvailable)("a Chrome launch that never becomes ready", { timeout: 60_000 }, () => {
	beforeAll(async () => {
		page = await serveFixturePage();
	});

	// Release resolves once the service's Chrome retirement ended; anything left is a leak.
	afterEach(async () => {
		await Promise.allSettled(grants.splice(0).map(({ service, grant }) => service.release(grant.clientId, owner)));
		const leaked = await bunChromeChildren();
		if (leaked.length > 0) await retireBunChrome(nativeClass());
		expect(leaked).toEqual([]);
	}, 60_000);

	afterAll(async () => {
		await page?.stop();
	});

	it("retires the stalled launch and answers the create from a fresh Chrome", async () => {
		const events: ReadinessEvent[] = [];
		const { webViewClass, attachDeadline, launches } = stallingLaunches((launch) => launch === 1);
		const service = new WebViewService(webViewClass, { attachDeadline, onReadiness: (e) => events.push(e) });
		const port = connect(service);
		expect(await create(port, "view")).toMatchObject({ ok: true });
		expect(await greetingAfterNavigate(port, "view")).toBe("hello from the fixture");
		expect(launches()).toBe(2);
		expect(events.map((event) => [event.type, event.launch])).toEqual([
			["stalled", 1],
			["ready", 2],
		]);
	});

	it("fails the create naming the phase, with no Chrome left, once every launch stalled", async () => {
		const { webViewClass, attachDeadline, launches } = stallingLaunches(() => true);
		const service = new WebViewService(webViewClass, { attachDeadline });
		const port = connect(service);
		const reply = await create(port, "view");
		expect(reply).toMatchObject({ ok: false, error: { code: "ERR_WEBVIEW_NOT_READY" } });
		expect(reply.error?.message).toContain("phase cdp-target-attach");
		expect(launches()).toBe(2);
		expect(await bunChromeChildren()).toEqual([]);
		expect(service.viewCount).toBe(0);
	});

	it("keeps another kernel's ready view on the shared Chrome while a stalled create fails", async () => {
		const { webViewClass, attachDeadline, launches } = stallingLaunches((launch) => launch > 1);
		const service = new WebViewService(webViewClass, { attachDeadline });
		const healthy = connect(service);
		const stalled = connect(service);
		expect(await create(healthy, "kept")).toMatchObject({ ok: true });
		expect(await create(stalled, "lost")).toMatchObject({ ok: false, error: { code: "ERR_WEBVIEW_NOT_READY" } });
		expect(launches()).toBe(3);
		expect(await greetingAfterNavigate(healthy, "kept")).toBe("hello from the fixture");
		expect(service.viewCount).toBe(1);
	});

	it("does not relaunch for a client released while its launch stalls, and leaves no Chrome behind", async () => {
		const { webViewClass, launches } = stallingLaunches(() => true);
		const stalled = Promise.withResolvers<void>();
		const bound = Promise.withResolvers<void>();
		const attachDeadline = (): AttachDeadline => {
			stalled.resolve();
			return { reached: bound.promise, cancel: () => {} };
		};
		const service = new WebViewService(webViewClass, { attachDeadline });
		const grant = service.connect(owner);
		grant.port.postMessage({
			kind: "create",
			id: 1,
			viewId: "view",
			options: { backend: "chrome" },
			captureConsole: false,
		});
		await stalled.promise;
		// The kernel goes away mid-stall (cell timeout, reset); only then is the launch's bound reached.
		const released = service.release(grant.clientId, owner);
		bound.resolve();
		await released;
		expect(launches()).toBe(1);
		expect(await bunChromeChildren()).toEqual([]);
		expect(service.viewCount).toBe(0);
	});
});
