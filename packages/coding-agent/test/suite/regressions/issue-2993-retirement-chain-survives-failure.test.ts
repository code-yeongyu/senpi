import { once } from "node:events";
import type { MessagePort } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { NativeWebView, NativeWebViewClass } from "../../../src/core/webview/native-webview.ts";
import type { AttachDeadline } from "../../../src/core/webview/webview-readiness.ts";
import { WebViewService } from "../../../src/core/webview/webview-service.ts";

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
	close(): void {}
}

const FakeViewClass: NativeWebViewClass = Object.assign(
	class extends FakeView {
		constructor(_options: Readonly<Record<string, unknown>>) {
			super();
		}
	},
	{ closeAll: () => {} },
);

const neverReached = (): AttachDeadline => ({ reached: new Promise(() => {}), cancel: () => {} });

type Reply = { readonly kind: "reply"; readonly id: number; readonly ok: boolean };

let nextId = 1;
function createView(port: MessagePort, viewId: string): Promise<Reply> {
	const id = nextId++;
	return new Promise((resolve) => {
		const onMessage = (reply: Reply): void => {
			if (reply.kind !== "reply" || reply.id !== id) return;
			port.off("message", onMessage);
			resolve(reply);
		};
		port.on("message", onMessage);
		port.postMessage({ kind: "create", id, viewId, options: { backend: "chrome" }, captureConsole: false });
	});
}

describe("a failed Chrome retirement (senpi#2993)", () => {
	it("#given a retirement that fails #when the kernel is released #then the caller gets the error, it is reported, and the next launch and retirement still run", async () => {
		// given
		const failures: string[] = [];
		const retirements: string[] = [];
		const service = new WebViewService(FakeViewClass, {
			attachDeadline: neverReached,
			onRetireFailure: (message) => failures.push(message),
			retireChrome: async () => {
				retirements.push("retire");
				if (retirements.length === 1) throw new Error("ENOENT: readiness log directory is missing");
			},
		});
		const owner = {};
		const first = service.connect(owner);
		expect(await createView(first.port, "a")).toMatchObject({ ok: true });

		// when
		const released = service.release(first.clientId, owner);

		// then
		await expect(released).rejects.toThrow("readiness log directory is missing");
		expect(failures).toEqual(["ENOENT: readiness log directory is missing"]);
		const second = service.connect(owner);
		expect(await createView(second.port, "b")).toMatchObject({ ok: true });
		await service.release(second.clientId, owner);
		expect(retirements).toEqual(["retire", "retire"]);
		first.port.close();
		second.port.close();
	});

	it("#given the readiness report itself throws #when a retirement fails #then the failure still reaches a process warning", async () => {
		// given
		const service = new WebViewService(FakeViewClass, {
			attachDeadline: neverReached,
			onRetireFailure: () => {
				throw new Error("log unwritable");
			},
			retireChrome: async () => {
				throw new Error("taskkill could not be spawned");
			},
		});
		const owner = {};
		const grant = service.connect(owner);
		expect(await createView(grant.port, "a")).toMatchObject({ ok: true });
		const warned = once(process, "warning", { signal: AbortSignal.timeout(3_000) });

		// when
		await expect(service.release(grant.clientId, owner)).rejects.toThrow("taskkill could not be spawned");

		// then
		const [warning] = (await warned) as [Error & { code?: string }];
		expect(warning.code).toBe("SENPI_WEBVIEW_RETIRE_FAILED");
		expect(warning.message).toContain("taskkill could not be spawned");
		grant.port.close();
	});
});
