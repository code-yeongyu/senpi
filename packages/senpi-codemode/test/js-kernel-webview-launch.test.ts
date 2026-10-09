import { describe, expect, it } from "vitest";
import { retireBunChrome } from "../../coding-agent/src/core/webview/bun-chrome.ts";
import { mainThreadWebViewClass, type NativeWebViewClass } from "../../coding-agent/src/core/webview/native-webview.ts";
import { type WebViewClientGrant, WebViewService } from "../../coding-agent/src/core/webview/webview-service.ts";
import { bunChromeChildren, bunWebViewAvailable } from "./eval/webview-fixtures.ts";

// Its own file, so the launch it drives runs in a process no earlier test has stopped or killed Chrome in.
describe.skipIf(!bunWebViewAvailable)("a Chrome launch whose kernel is released mid-launch", () => {
	it("retires the Chrome a launch starts after its kernel was released mid-launch", async () => {
		const nativeClass = mainThreadWebViewClass();
		if (!nativeClass) throw new Error("expected Bun.WebView on the main thread");
		const owner = {};
		const launched = Promise.withResolvers<void>();
		let grant: WebViewClientGrant | undefined;
		let released: Promise<void> | undefined;
		let attempts = 0;
		// The kernel is released (cell timeout, reset, close) while Windows still refuses to relaunch
		// Chrome; the retried launch then starts a Chrome no view will ever use.
		const launching: NativeWebViewClass = new Proxy(nativeClass, {
			construct(target, args) {
				attempts += 1;
				if (attempts === 1) {
					if (grant) released = service.release(grant.clientId, owner);
					throw Object.assign(new Error("Failed to spawn Chrome"), { code: "ERR_DLOPEN_FAILED" });
				}
				const view: object = Reflect.construct(target, args);
				launched.resolve();
				return view;
			},
		});
		const service = new WebViewService(launching);
		grant = service.connect(owner);
		try {
			grant.port.postMessage({
				kind: "create",
				id: 1,
				viewId: "late",
				options: { backend: "chrome" },
				captureConsole: false,
			});
			await launched.promise;
			await released;
			expect(attempts).toBe(2);
			expect(await bunChromeChildren()).toEqual([]);
		} finally {
			grant.port.close();
			// Keep a regression here from leaking its Chrome into the next test, through the product's own
			// retire: `closeAll()` on macOS would also end the WebKit host other processes' views run on.
			await retireBunChrome(nativeClass);
		}
	});
});
