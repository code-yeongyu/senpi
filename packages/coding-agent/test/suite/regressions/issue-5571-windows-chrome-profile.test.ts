import { describe, expect, it } from "vitest";
import {
	type BunChromeBrowser,
	type ChromeRetireSeams,
	retireBunChrome,
} from "../../../src/core/webview/bun-chrome.ts";
import type { NativeWebView, NativeWebViewClass } from "../../../src/core/webview/native-webview.ts";
import { parseWindowsProcessRows } from "../../../src/core/webview/windows-chrome-tree.ts";

// Bun 1.4 makes this profile on Windows too (`<tmpdir>\.<hex>-<n>.bun-chrome`), and neither Bun nor Chrome deletes it.
const PROFILE = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\.0a1b2c3d4e5f6071-00000000.bun-chrome`;
const CHROME = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe"`;

/** A view class no case may construct: a Chrome that already exited is retired without opening a view. */
class NoView extends EventTarget implements NativeWebView {
	url = "about:blank";
	title = "";
	loading = false;
	onNavigated: ((url: string, title: string) => void) | null = null;
	onNavigationFailed: ((error: Error) => void) | null = null;
	constructor(_options: Readonly<Record<string, unknown>>) {
		super();
		throw new Error("an exited Chrome is retired without opening a view");
	}
	navigate(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}
const noViews: NativeWebViewClass = Object.assign(NoView, { closeAll: () => {} });

function windowsRetirement(browsers: readonly BunChromeBrowser[], treeGone: boolean) {
	const removed: string[] = [];
	const seams: ChromeRetireSeams = {
		platform: "win32",
		listBrowsers: async () => browsers,
		alive: () => false,
		signal: () => {
			throw new Error("Windows Chrome is ended by the tree kill, never by a signal");
		},
		deadline: () => ({ reached: new Promise(() => {}), cancel: () => {} }),
		requestClose: async () => false,
		killWindowsTree: async () => treeGone,
		removeProfile: async (dir) => {
			removed.push(dir);
		},
	};
	return { seams, removed };
}

describe("retiring Bun's Chrome on Windows removes its temp profile (senpi#5571)", () => {
	it("#given a Chrome whose tree is gone after the tree kill #when it is retired #then its .bun-chrome profile is removed", async () => {
		// given
		const run = windowsRetirement([{ pid: 7000, profileDir: PROFILE }, { pid: 7100 }], true);

		// when
		await retireBunChrome(noViews, run.seams);

		// then
		expect(run.removed).toEqual([PROFILE]);
	});

	it("#given a tree kill that left the tree running #when it is retired #then the profile Chrome still holds is kept", async () => {
		// given
		const run = windowsRetirement([{ pid: 7000, profileDir: PROFILE }], false);

		// when
		await retireBunChrome(noViews, run.seams);

		// then
		expect(run.removed).toEqual([]);
	});

	it("#given CIM rows carrying the command line after a tab #when parsed #then only a flagged browser names its profile", () => {
		// given
		const stdout = [
			`7000 5000 134046263569141430 1 chrome.exe\t${CHROME} --user-data-dir=${PROFILE} --remote-debugging-pipe --headless`,
			`7100 7000 134046263569141500 0 chrome.exe\t`,
			`7200 5000 134046263569141600 0 chrome.exe\t${CHROME} --user-data-dir=${PROFILE}`,
			"0 0 0 0 System Idle Process\t",
			"896 776 134046261411081720 0 wininit.exe",
		].join("\r\n");

		// when
		const rows = parseWindowsProcessRows(stdout);

		// then
		expect(rows.map((row) => [row.pid, row.name, row.profileDir])).toEqual([
			[7000, "chrome.exe", PROFILE],
			[7100, "chrome.exe", undefined],
			[7200, "chrome.exe", undefined],
			[896, "wininit.exe", undefined],
		]);
	});
});
