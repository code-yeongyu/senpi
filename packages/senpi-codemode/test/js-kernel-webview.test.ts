import { appendFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
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

// senpi#5712: vitest runs each file in its own process, so the first chrome-backed cell of this file pays the
// run's one-time cold Chrome launch, CDP target attach and first navigation. That took 30-51 s of the case's
// 60 s on green windows-latest main runs and ran past it on slow ones, while later cells take a few seconds.
// A user's first chrome-backed cell pays that cost too, so it is not hidden: the file pays it once here, through
// the same eval-cell path, under a bounded budget of its own. Every stage prints before it starts, so a warm-up
// that stalls fails naming the stage (launch, navigate, evaluate) and the time spent; the stage times go to
// SENPI_WEBVIEW_READINESS_LOG when it is set. No case deadline is raised.
const WARM_UP_CELL_TIMEOUT_MS = 110_000;
const WARM_UP_TIMEOUT_MS = WARM_UP_CELL_TIMEOUT_MS + 30_000;

function stdoutOf(messages: readonly KernelToHostMessage[]): string {
	return messages
		.map((message) => (message.type === "text" && message.stream === "stdout" ? message.data : ""))
		.join("");
}

async function warmUpChromeCell(): Promise<void> {
	const kernel = new JavaScriptKernel({
		sessionId: `webview-warm-up-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
	});
	const startedAt = performance.now();
	let retireMs = 0;
	try {
		const run = await runJavaScriptCell(
			kernel,
			[
				`const started = performance.now();`,
				`const stage = (name) => console.log(\`stage \${name} at \${Math.round(performance.now() - started)} ms\`);`,
				`stage("launch");`,
				`const view = new Bun.WebView({ backend: "chrome", width: 320, height: 240 });`,
				`stage("navigate");`,
				`await view.navigate(${JSON.stringify(fixtureUrl())});`,
				`stage("evaluate");`,
				`const greeting = await view.evaluate("document.getElementById('greeting').textContent");`,
				`stage("done");`,
				`view.close();`,
				`return greeting;`,
			].join("\n"),
			WARM_UP_CELL_TIMEOUT_MS,
		);
		const stages = stdoutOf(run.messages).trim().split("\n").join("; ");
		if (!run.result.ok)
			throw new Error(`chrome warm-up cell failed (${run.result.error.message}); stages: ${stages}`);
		expect(parseJavaScriptResult(run.result)).toBe("hello from the fixture");
		const path = process.env.SENPI_WEBVIEW_READINESS_LOG;
		if (path) appendFileSync(path, `${new Date().toISOString()} pid=${process.pid} chrome cell warm-up ${stages}\n`);
	} finally {
		const retireStartedAt = performance.now();
		await kernel.close();
		retireMs = Math.round(performance.now() - retireStartedAt);
		const path = process.env.SENPI_WEBVIEW_READINESS_LOG;
		if (path)
			appendFileSync(
				path,
				`${new Date().toISOString()} pid=${process.pid} chrome cell warm-up totalMs=${Math.round(performance.now() - startedAt)} retireMs=${retireMs}\n`,
			);
	}
	expect(await bunChromeChildren()).toEqual([]);
}

describe.skipIf(!bunWebViewAvailable)("Bun.WebView from an eval cell", { timeout: TEST_TIMEOUT_MS }, () => {
	beforeAll(async () => {
		page = await serveFixturePage();
		await warmUpChromeCell();
	}, WARM_UP_TIMEOUT_MS);

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

	it("serves the default backend from the main-thread service on every platform", async () => {
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
			proxied: true,
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

	it.each(["default", "chrome"])(
		"walks the %s-backend view's history with goBack() and goForward()",
		async (backend) => {
			// WebKit acknowledges history commands before navigation finishes, while Chrome emits
			// onNavigated at frame commit, before its command promise clears the navigation slot.
			// Wait for both signals so neither backend starts the next command too early.
			// Data URLs force document loads: Chrome's HTTP back-forward cache can restore without
			// the load event Bun uses to settle its native history promise.
			const firstUrl = `data:text/html,${encodeURIComponent("<title>first</title>")}`;
			const secondUrl = `data:text/html,${encodeURIComponent("<title>second</title>")}`;
			const value = await cell(
				[
					`await using view = new Bun.WebView({ width: 320, height: 240, ${backend === "chrome" ? 'backend: "chrome"' : ""} });`,
					`await view.navigate(${JSON.stringify(firstUrl)});`,
					`await view.navigate(${JSON.stringify(secondUrl)});`,
					`const settled = async (move) => {`,
					`  const navigated = new Promise((resolve, reject) => { view.onNavigated = resolve; view.onNavigationFailed = reject; });`,
					`  const [url] = await Promise.all([navigated, move()]);`,
					`  return url;`,
					`};`,
					`const back = await settled(() => view.goBack());`,
					`const forward = await settled(() => view.goForward());`,
					`return { back, forward };`,
				].join("\n"),
			);
			expect(value).toEqual({ back: firstUrl, forward: secondUrl });
		},
	);

	// senpi#4794: Bun's WebKit host client is bound to the first thread that spawns it, so a WebKit view
	// built in a kernel worker broke every view after that worker exited and corrupted the heap once a
	// second worker used one.
	describe.skipIf(process.platform !== "darwin")("the macOS default (WebKit) backend", () => {
		const openDefaultView = () =>
			[
				`const view = new Bun.WebView({ width: 320, height: 240 });`,
				`await view.navigate(${JSON.stringify(fixtureUrl())});`,
				`const greeting = await view.evaluate("document.getElementById('greeting').textContent");`,
				`view.close();`,
				`return greeting;`,
			].join("\n");

		it("serves a fresh view after the kernel that opened the first one resets", async () => {
			const kernel = openKernel();
			const run = async () =>
				parseJavaScriptResult((await runJavaScriptCell(kernel, openDefaultView(), CELL_TIMEOUT_MS)).result);
			expect(await run()).toBe("hello from the fixture");
			await kernel.reset();
			expect(await run()).toBe("hello from the fixture");
		});

		it("drives views from two kernels at once", async () => {
			const first = openKernel();
			const second = openKernel();
			const run = async (kernel: JavaScriptKernel) =>
				parseJavaScriptResult((await runJavaScriptCell(kernel, openDefaultView(), CELL_TIMEOUT_MS)).result);
			for (let round = 0; round < 3; round++) {
				expect(await Promise.all([run(first), run(second)])).toEqual([
					"hello from the fixture",
					"hello from the fixture",
				]);
			}
		});
	});
});
