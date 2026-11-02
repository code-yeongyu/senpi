import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
	type BunChromeBrowser,
	type ChromeRetireSeams,
	retireBunChrome,
} from "../../../src/core/webview/bun-chrome.ts";
import { bunChromeProfileDir, requestBrowserClose } from "../../../src/core/webview/chrome-graceful-close.ts";
import type { NativeWebView, NativeWebViewClass } from "../../../src/core/webview/native-webview.ts";
import type { AttachDeadline } from "../../../src/core/webview/webview-readiness.ts";

const PROFILE = "/var/folders/xy/T/.0a1b2c3d4e5f6071-00000000.bun-chrome";

interface FakeChrome {
	readonly webViewClass: NativeWebViewClass;
	readonly cdpCalls: string[];
	readonly closeAllCalls: number[];
	readonly constructed: number[];
}

/** A view class whose CDP `Browser.close` either runs `onBrowserClose` and resolves, or never answers. */
function fakeChrome(onBrowserClose: (() => void) | "hang"): FakeChrome {
	const cdpCalls: string[] = [];
	const closeAllCalls: number[] = [];
	const constructed: number[] = [];
	class FakeView extends EventTarget implements NativeWebView {
		url = "about:blank";
		title = "";
		loading = false;
		onNavigated: ((url: string, title: string) => void) | null = null;
		onNavigationFailed: ((error: Error) => void) | null = null;
		constructor(_options: Readonly<Record<string, unknown>>) {
			super();
			constructed.push(1);
		}
		navigate(): Promise<void> {
			return Promise.resolve();
		}
		close(): void {}
		cdp(method: string): Promise<unknown> {
			cdpCalls.push(method);
			if (onBrowserClose === "hang") return new Promise(() => {});
			onBrowserClose();
			return Promise.resolve({});
		}
	}
	const webViewClass: NativeWebViewClass = Object.assign(FakeView, { closeAll: () => closeAllCalls.push(1) });
	return { webViewClass, cdpCalls, closeAllCalls, constructed };
}

/** Deadlines the test reaches by hand, in the order the retirement asks for them. */
function manualDeadlines() {
	const requested: Array<{ readonly ms: number; readonly reach: () => void }> = [];
	const waiters: Array<() => void> = [];
	const deadline = (ms: number): AttachDeadline => {
		const reached = Promise.withResolvers<void>();
		requested.push({ ms, reach: () => reached.resolve() });
		waiters.shift()?.();
		return { reached: reached.promise, cancel: () => {} };
	};
	// A retirement that settles without asking for this deadline fails the case instead of hanging it.
	const next = async (
		index: number,
		retired: Promise<void>,
	): Promise<{ readonly ms: number; readonly reach: () => void }> => {
		const settled = retired.then(
			() => "settled" as const,
			() => "settled" as const,
		);
		while (requested.length <= index) {
			const woke = await Promise.race([
				new Promise<"asked">((resolve) => waiters.push(() => resolve("asked"))),
				settled,
			]);
			if (woke === "settled" && requested.length <= index)
				throw new Error(`retirement settled without asking for deadline ${index}`);
		}
		const entry = requested[index];
		if (!entry) throw new Error(`deadline ${index} was never requested`);
		return entry;
	};
	return { deadline, next };
}

function seams(overrides: Partial<ChromeRetireSeams> & Pick<ChromeRetireSeams, "platform" | "alive">): {
	readonly seams: ChromeRetireSeams;
	readonly signals: Array<readonly [number, NodeJS.Signals]>;
	readonly removed: string[];
	readonly treeKills: number[];
} {
	const signals: Array<readonly [number, NodeJS.Signals]> = [];
	const removed: string[] = [];
	const treeKills: number[] = [];
	return {
		signals,
		removed,
		treeKills,
		seams: {
			listBrowsers: async () => [],
			signal: (pid, signal) => signals.push([pid, signal]),
			deadline: () => ({ reached: new Promise(() => {}), cancel: () => {} }),
			requestClose: requestBrowserClose,
			killWindowsTree: async () => {
				treeKills.push(1);
			},
			removeProfile: async (dir) => {
				removed.push(dir);
			},
			...overrides,
		},
	};
}

function alivePids(pids: Iterable<number>): { readonly set: Set<number>; readonly alive: (pid: number) => boolean } {
	const set = new Set(pids);
	return { set, alive: (pid) => set.has(pid) };
}

/** A real process that ignores SIGTERM, so only SIGKILL can end it. */
async function stubbornChild(): Promise<ChildProcess & { pid: number }> {
	const child = spawn(
		process.execPath,
		["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 60_000);"],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await once(child.stdout, "data");
	if (child.pid === undefined) throw new Error("child has no pid");
	return Object.assign(child, { pid: child.pid });
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("retiring Bun's Chrome quits it over CDP first (senpi#4174)", () => {
	it("#given a Chrome that honors Browser.close #when it is retired on macOS #then nothing is signalled and its profile is removed", async () => {
		// given
		const chrome = alivePids([7001]);
		const fake = fakeChrome(() => chrome.set.delete(7001));
		const run = seams({
			platform: "darwin",
			alive: chrome.alive,
			listBrowsers: async (): Promise<BunChromeBrowser[]> => [{ pid: 7001, profileDir: PROFILE }],
		});

		// when
		await retireBunChrome(fake.webViewClass, run.seams);

		// then
		expect(fake.cdpCalls).toEqual(["Browser.close"]);
		expect(run.signals).toEqual([]);
		expect(fake.closeAllCalls).toEqual([]);
		expect(run.removed).toEqual([PROFILE]);
	});

	it("#given no Chrome running #when it is retired #then no view is opened, so no Chrome is launched", async () => {
		// given
		const fake = fakeChrome(() => {});
		const run = seams({ platform: "darwin", alive: () => false });

		// when
		await retireBunChrome(fake.webViewClass, run.seams);

		// then
		expect(fake.constructed).toEqual([]);
		expect(run.signals).toEqual([]);
	});

	it("#given Browser.close never answers #when the grace bound passes #then SIGTERM, then SIGKILL after its bound, ends Chrome and the profile goes", async () => {
		// given
		const child = await stubbornChild();
		const exited = once(child, "exit");
		const deadlines = manualDeadlines();
		const fake = fakeChrome("hang");
		const run = seams({
			platform: "darwin",
			alive: processAlive,
			listBrowsers: async () => [{ pid: child.pid, profileDir: PROFILE }],
			deadline: deadlines.deadline,
			signal: (pid, signal) => {
				run.signals.push([pid, signal]);
				process.kill(pid, signal);
			},
		});
		try {
			// when
			const retired = retireBunChrome(fake.webViewClass, run.seams);
			const grace = await deadlines.next(0, retired);
			expect(fake.cdpCalls).toEqual(["Browser.close"]);
			expect(run.signals).toEqual([]);
			grace.reach();
			const term = await deadlines.next(1, retired);
			expect(run.signals).toEqual([[child.pid, "SIGTERM"]]);
			term.reach();
			await deadlines.next(2, retired);
			await retired;

			// then
			expect(run.signals).toEqual([
				[child.pid, "SIGTERM"],
				[child.pid, "SIGKILL"],
			]);
			expect(await exited).toEqual([null, "SIGKILL"]);
			expect(run.removed).toEqual([PROFILE]);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("#given Browser.close never answers on Windows #when the grace bound passes #then the existing tree kill runs, and nothing before it", async () => {
		// given
		const chrome = alivePids([7100, 7101]);
		const deadlines = manualDeadlines();
		const fake = fakeChrome("hang");
		const run = seams({
			platform: "win32",
			alive: chrome.alive,
			listBrowsers: async () => [{ pid: 7100 }, { pid: 7101 }],
			deadline: deadlines.deadline,
		});
		const treeKilled = Promise.withResolvers<void>();
		const windows: ChromeRetireSeams = {
			...run.seams,
			killWindowsTree: async (webViewClass) => {
				expect(webViewClass).toBe(fake.webViewClass);
				run.treeKills.push(1);
				chrome.set.clear();
				treeKilled.resolve();
			},
		};

		// when
		const retired = retireBunChrome(fake.webViewClass, windows);
		const grace = await deadlines.next(0, retired);
		expect(fake.cdpCalls).toEqual(["Browser.close"]);
		expect(run.treeKills).toEqual([]);
		grace.reach();
		await treeKilled.promise;
		await retired;

		// then
		expect(run.treeKills).toEqual([1]);
		expect(run.signals).toEqual([]);
		expect(run.removed).toEqual([]);
	});

	it("#given Bun's Chrome command line #when its profile is read #then only a Bun .bun-chrome profile is named", () => {
		const command = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-pipe --headless`;
		expect(bunChromeProfileDir(command)).toBe(PROFILE);
		expect(
			bunChromeProfileDir("chrome --user-data-dir=/Users/someone/Library/Application Support/Google/Chrome"),
		).toBe(undefined);
		expect(bunChromeProfileDir("chrome --user-data-dir=/tmp/.x.bun-chrome-extra --headless")).toBe(undefined);
	});
});
