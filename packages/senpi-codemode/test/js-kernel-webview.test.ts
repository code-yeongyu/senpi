import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";
import {
	bunChromeChildren,
	bunWebViewAvailable,
	serveFixturePage,
	type WebViewFixturePage,
} from "./eval/webview-fixtures.ts";

const CELL_TIMEOUT_MS = 60_000;
// The cell's own timeout is what ends a launch that never finishes: it retires the worker and
// the Chrome it started. Vitest must not abandon the test first, or the kernel keeps running into
// the next test; this budget only backstops a hang in the kernel's own settlement and teardown.
const TEST_TIMEOUT_MS = CELL_TIMEOUT_MS + 30_000;

let page: WebViewFixturePage | undefined;
const kernels: JavaScriptKernel[] = [];

function openKernel(): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `webview-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
	});
	kernels.push(kernel);
	return kernel;
}

async function cell(code: string): Promise<unknown> {
	return parseJavaScriptResult((await runJavaScriptCell(openKernel(), code, CELL_TIMEOUT_MS)).result);
}

function fixtureUrl(): string {
	if (!page) throw new Error("fixture page is not running");
	return page.url;
}

describe.skipIf(!bunWebViewAvailable)("Bun.WebView from an eval cell", { timeout: TEST_TIMEOUT_MS }, () => {
	beforeAll(async () => {
		page = await serveFixturePage();
	});

	// Closing the kernel releases its views and retires the Chrome they used, and resolves once that
	// Chrome is gone; it runs even when the test failed, so nothing reaches the next test.
	afterEach(async () => {
		await Promise.allSettled(kernels.splice(0).map((kernel) => kernel.close()));
		expect(await bunChromeChildren()).toEqual([]);
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		await page?.stop();
	});

	it("drives a chrome-backed view: navigate, evaluate, click, screenshot", async () => {
		const value = await cell(
			[
				`const view = new Bun.WebView({ backend: "chrome", width: 640, height: 480 });`,
				`await view.navigate(${JSON.stringify(fixtureUrl())});`,
				`const greeting = await view.evaluate("document.getElementById('greeting').textContent");`,
				`await view.click("#go");`,
				`const title = await view.evaluate("document.title");`,
				`const shot = await view.screenshot();`,
				`const bytes = new Uint8Array(await shot.arrayBuffer());`,
				`const result = { greeting, title, url: view.url, isBlob: shot instanceof Blob, type: shot.type, png: bytes[0] === 0x89 && bytes[1] === 0x50, size: bytes.length };`,
				`view.close();`,
				`return result;`,
			].join("\n"),
		);
		expect(value).toMatchObject({
			greeting: "hello from the fixture",
			title: "clicked",
			url: fixtureUrl(),
			isBlob: true,
			type: "image/png",
			png: true,
		});
	});

	it("serves the default backend: native WebKit in the worker on macOS, the main-thread Chrome elsewhere", async () => {
		const value = await cell(
			[
				`await using view = new Bun.WebView({ width: 320, height: 240 });`,
				`await view.navigate(${JSON.stringify(fixtureUrl())});`,
				`const greeting = await view.evaluate("document.getElementById('greeting').textContent");`,
				`return { greeting, proxied: Object.getPrototypeOf(view) === Bun.WebView.prototype, isWebView: view instanceof Bun.WebView };`,
			].join("\n"),
		);
		expect(value).toEqual({
			greeting: "hello from the fixture",
			proxied: process.platform !== "darwin",
			isWebView: true,
		});
	});

	it('proxies the WebView named by `import { WebView } from "bun"`, with console capture and raw CDP', async () => {
		const value = await cell(
			[
				`import { WebView } from "bun";`,
				`const logged = [];`,
				`const view = new WebView({ backend: "chrome", console: (type, ...args) => logged.push([type, ...args]) });`,
				`await view.navigate(${JSON.stringify(fixtureUrl())});`,
				`await view.evaluate("console.log('from the page', 7)");`,
				`const cdp = await view.cdp("Runtime.evaluate", { expression: "6 * 7", returnByValue: true });`,
				`view.close();`,
				`return { logged, answer: cdp.result.value };`,
			].join("\n"),
		);
		expect(value).toEqual({ logged: [["log", "from the page", 7]], answer: 42 });
	});
});
