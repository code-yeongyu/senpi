import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mainThreadWebViewService } from "../../coding-agent/src/core/webview/webview-service.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";
import {
	bunChromeChildren,
	bunWebViewAvailable,
	serveFixturePage,
	type WebViewFixturePage,
} from "./eval/webview-fixtures.ts";

const CELL_TIMEOUT_MS = 60_000;
// Cells run under their own timeouts (up to CELL_TIMEOUT_MS), which retire a stuck worker and its
// Chrome; vitest must not abandon a test before that, or its kernel runs on into the next test.
const BUDGET = { timeout: CELL_TIMEOUT_MS + 30_000 };

let page: WebViewFixturePage | undefined;
const kernels: JavaScriptKernel[] = [];

function openKernel(): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `webview-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 1,
	});
	kernels.push(kernel);
	return kernel;
}

async function cell(kernel: JavaScriptKernel, code: string, timeoutMs = CELL_TIMEOUT_MS): Promise<unknown> {
	return parseJavaScriptResult((await runJavaScriptCell(kernel, code, timeoutMs)).result);
}

function openViewCell(): string {
	if (!page) throw new Error("fixture page is not running");
	return [
		`globalThis.view = new Bun.WebView({ backend: "chrome", width: 320, height: 240 });`,
		`await view.navigate(${JSON.stringify(page.url)});`,
		`return await view.evaluate("document.getElementById('greeting').textContent");`,
	].join("\n");
}

async function onlyBunChrome(): Promise<number> {
	const pids = await bunChromeChildren();
	expect(pids).toHaveLength(1);
	const [pid] = pids;
	if (pid === undefined) throw new Error("no Bun Chrome child");
	return pid;
}

describe.skipIf(!bunWebViewAvailable)("a misbehaving Chrome behind the main-thread WebView service", BUDGET, () => {
	beforeAll(async () => {
		page = await serveFixturePage();
	});

	afterEach(async () => {
		await Promise.allSettled(kernels.splice(0).map((kernel) => kernel.close()));
		await vi.waitFor(async () => expect(await bunChromeChildren()).toEqual([]), { timeout: 30_000, interval: 100 });
		expect(mainThreadWebViewService()?.viewCount ?? 0).toBe(0);
	}, 60_000);

	afterAll(async () => {
		await page?.stop();
	});

	it.skipIf(process.platform === "win32")(
		"keeps the main thread and other kernels serving while Chrome is hung",
		async () => {
			const stuck = openKernel();
			const bystander = openKernel();
			expect(await cell(stuck, openViewCell())).toBe("hello from the fixture");
			const chrome = await onlyBunChrome();
			process.kill(chrome, "SIGSTOP");
			const order: string[] = [];
			const hung = runJavaScriptCell(stuck, `return await view.evaluate("1 + 1")`, 4_000).then((run) => {
				order.push("hung-cell-settled");
				return run;
			});
			await new Promise((resolve) => setImmediate(resolve));
			order.push("main-thread-turn");
			expect(await cell(bystander, "return 40 + 2")).toBe(42);
			order.push("bystander-cell");
			const run = await hung;
			expect(order).toEqual(["main-thread-turn", "bystander-cell", "hung-cell-settled"]);
			expect(run.result.ok).toBe(false);
			await stuck.close();
		},
	);

	it("rejects instead of hanging when Chrome dies, and serves a new view afterwards", async () => {
		const kernel = openKernel();
		expect(await cell(kernel, openViewCell())).toBe("hello from the fixture");
		process.kill(await onlyBunChrome(), "SIGKILL");
		const afterCrash = await runJavaScriptCell(
			kernel,
			`try { await view.evaluate("1 + 1"); return "resolved"; } catch (error) { return "rejected: " + error.message; }`,
			20_000,
		);
		expect(parseJavaScriptResult(afterCrash.result)).toMatch(/^rejected: /u);
		expect(await cell(kernel, `view.close();\n${openViewCell()}`)).toBe("hello from the fixture");
	});
});
