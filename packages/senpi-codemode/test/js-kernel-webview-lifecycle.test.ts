import type { MessagePort } from "node:worker_threads";
import { Worker } from "node:worker_threads";
import { connectWebViewService } from "@code-yeongyu/senpi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebViewBroker } from "../../coding-agent/src/core/webview/webview-broker.ts";
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

function url(): string {
	if (!page) throw new Error("fixture page is not running");
	return page.url;
}

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

const openView = [
	`globalThis.view = new Bun.WebView({ backend: "chrome", width: 320, height: 240 });`,
	`await view.navigate(URL_PLACEHOLDER);`,
	`return await view.evaluate("document.getElementById('greeting').textContent");`,
].join("\n");

function openViewCell(): string {
	return openView.replace("URL_PLACEHOLDER", JSON.stringify(url()));
}

async function expectNoBunChrome(): Promise<void> {
	await vi.waitFor(async () => expect(await bunChromeChildren()).toEqual([]), { timeout: 30_000, interval: 100 });
	expect(mainThreadWebViewService()?.viewCount ?? 0).toBe(0);
}

type Reply = {
	readonly kind: "reply";
	readonly id: number;
	readonly ok: boolean;
	readonly error?: { readonly message: string };
};

function request(
	port: MessagePort,
	message: Readonly<Record<string, unknown>> & { readonly id: number },
): Promise<Reply> {
	return new Promise((resolve) => {
		const onMessage = (reply: Reply): void => {
			if (reply.kind !== "reply" || reply.id !== message.id) return;
			port.off("message", onMessage);
			resolve(reply);
		};
		port.on("message", onMessage);
		port.postMessage(message);
	});
}

describe.skipIf(!bunWebViewAvailable)("Bun.WebView lifecycle across eval kernels", BUDGET, () => {
	beforeAll(async () => {
		page = await serveFixturePage();
	});

	afterEach(async () => {
		await Promise.allSettled(kernels.splice(0).map((kernel) => kernel.close()));
		await expectNoBunChrome();
	}, 60_000);

	afterAll(async () => {
		await page?.stop();
	});

	it("keeps one kernel's views out of another kernel's reach", async () => {
		const owner = openKernel();
		const other = openKernel();
		expect(await cell(owner, openViewCell())).toBe("hello from the fixture");
		expect(await cell(other, openViewCell())).toBe("hello from the fixture");
		await cell(other, "Bun.WebView.closeAll(); return true;");
		await other.reset();
		expect(await cell(owner, `return await view.evaluate("document.title")`)).toBe("kernel-webview");
	});

	it("answers a raw port that names another client's view as unknown, and leaves that view alive", async () => {
		const owner = await connectWebViewService();
		const intruder = await connectWebViewService();
		try {
			const viewId = "owner-view";
			const created = await request(owner.port, {
				kind: "create",
				id: 1,
				viewId,
				options: { backend: "chrome" },
				captureConsole: false,
			});
			expect(created.ok).toBe(true);
			const drive = await request(intruder.port, { kind: "call", id: 1, viewId, method: "navigate", args: [url()] });
			expect(drive).toMatchObject({ ok: false, error: { message: expect.stringContaining("Unknown WebView") } });
			intruder.port.postMessage({ kind: "close", viewId });
			await intruder.release();
			const still = await request(owner.port, { kind: "call", id: 2, viewId, method: "navigate", args: [url()] });
			expect(still.ok).toBe(true);
		} finally {
			await owner.release();
			await intruder.release();
			owner.port.close();
			intruder.port.close();
		}
	});

	it("closes a view the cell left open when its kernel resets, then serves a fresh one", async () => {
		const kernel = openKernel();
		expect(await cell(kernel, openViewCell())).toBe("hello from the fixture");
		expect((await bunChromeChildren()).length).toBeGreaterThan(0);
		await kernel.reset();
		await expectNoBunChrome();
		expect(await cell(kernel, openViewCell())).toBe("hello from the fixture");
	});

	it("closes a view the cell left open when its session closes the kernel", async () => {
		const kernel = openKernel();
		expect(await cell(kernel, openViewCell())).toBe("hello from the fixture");
		await kernel.close();
		await expectNoBunChrome();
	});

	it("closes the view of a cell that hangs past its timeout", async () => {
		const kernel = openKernel();
		const run = await runJavaScriptCell(
			kernel,
			`${openViewCell().replace(/return .*$/u, "")}\nawait new Promise(() => {});`,
			8_000,
		);
		expect(run.result.ok).toBe(false);
		// The timeout keeps the worker (#2788): the cell's view closes with it, and Chrome stays warm for the next
		// view exactly as after an explicit view.close(), until the kernel closes.
		await vi.waitFor(() => expect(mainThreadWebViewService()?.viewCount ?? 0).toBe(0), {
			timeout: 30_000,
			interval: 100,
		});
		await expect(
			cell(kernel, `return await view.evaluate("1").then(() => "open", (error) => String(error.message))`),
		).resolves.toMatch(/view is closed/u);
		await kernel.close();
		await expectNoBunChrome();
	});

	it("releases a killed session worker's views and leaves no Chrome", async () => {
		const broker = createWebViewBroker();
		if (!broker) throw new Error("expected a main-thread WebView service");
		const worker = new Worker(new URL("./eval/webview-session-worker-fixture.ts", import.meta.url), {
			workerData: { webviewBroker: broker.port, url: url() },
			transferList: [broker.port],
		});
		const result: unknown = await new Promise((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
		expect(result).toMatchObject({ ok: true, valueRepr: JSON.stringify("hello from the fixture") });
		expect(mainThreadWebViewService()?.viewCount).toBe(1);
		await worker.terminate();
		await expectNoBunChrome();
		await broker.dispose();
	});
});
