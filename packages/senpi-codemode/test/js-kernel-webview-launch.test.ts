import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { retireBunChrome } from "../../coding-agent/src/core/webview/bun-chrome.ts";
import { bunChromeProfileDir } from "../../coding-agent/src/core/webview/chrome-graceful-close.ts";
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

// macOS Chrome runs from a private clone of its app bundle here and deletes it only on a graceful quit.
function macCloneParent(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	const userTemp = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
	return join(userTemp, "..", "X", "com.google.Chrome.code_sign_clone");
}

function entries(dir: string | undefined): string[] {
	return dir !== undefined && existsSync(dir) ? readdirSync(dir) : [];
}

function chromeCommand(pid: number): string {
	return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

/** Resolves the paths of `clones` still present once all are gone or `boundMs` passed, watching their parent. */
async function remainingAfter(parent: string, clones: readonly string[], boundMs: number): Promise<string[]> {
	const left = (): string[] => clones.filter((clone) => existsSync(clone));
	if (left().length === 0) return [];
	const gone = Promise.withResolvers<void>();
	const watcher = watch(parent, () => {
		if (left().length === 0) gone.resolve();
	});
	const bound = setTimeout(gone.resolve, boundMs);
	try {
		if (left().length === 0) gone.resolve();
		await gone.promise;
		return left();
	} finally {
		clearTimeout(bound);
		watcher.close();
	}
}

// senpi#4174: a retirement that killed Chrome left its code_sign_clone copy and its profile behind.
describe.skipIf(!bunWebViewAvailable)("retiring a real Bun Chrome (senpi#4174)", () => {
	it("#given a launched Chrome #when it is retired #then its process, its code_sign_clone and its profile are gone", async () => {
		// given
		const nativeClass = mainThreadWebViewClass();
		if (!nativeClass) throw new Error("expected Bun.WebView on the main thread");
		const cloneParent = macCloneParent();
		const before = new Set(entries(cloneParent));
		const view = new nativeClass({ backend: "chrome" });
		let launchedClones: string[] = [];
		let profile: string | undefined;
		try {
			await view.navigate("about:blank");
			const pids = await bunChromeChildren();
			expect(pids).toHaveLength(1);
			const [pid = 0] = pids;
			profile = bunChromeProfileDir(chromeCommand(pid));
			expect(profile).toBeDefined();
			if (cloneParent !== undefined)
				launchedClones = entries(cloneParent)
					.filter((entry) => !before.has(entry))
					.map((entry) => join(cloneParent, entry));
			view.close();

			// when
			await retireBunChrome(nativeClass);

			// then
			expect(await bunChromeChildren()).toEqual([]);
			expect(profile !== undefined && existsSync(profile)).toBe(false);
			if (cloneParent !== undefined) expect(await remainingAfter(cloneParent, launchedClones, 10_000)).toEqual([]);
		} finally {
			await retireBunChrome(nativeClass);
			// Only what this launch created, so a regression here leaks nothing into the host.
			for (const path of [...launchedClones, ...(profile === undefined ? [] : [profile])])
				rmSync(path, { recursive: true, force: true });
		}
	});
});
