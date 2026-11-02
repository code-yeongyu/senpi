import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { bunChromeProfileDir, exitedWithin, requestBrowserClose } from "./chrome-graceful-close.ts";
import { mainThreadWebViewClass, type NativeWebViewClass } from "./native-webview.ts";
import { type AttachDeadline, timedDeadline } from "./webview-readiness.ts";
import {
	BROWSER_IMAGE,
	bunChromeKillPlan,
	type ChromeKillPlan,
	parseWindowsProcessRows,
	WINDOWS_PROCESS_ROWS,
} from "./windows-chrome-tree.ts";

// Bun launches its Chrome with exactly this default flag run (see `Bun.WebView` backend docs);
// together with the parent pid it tells Bun's browser apart from any other Chrome we spawned.
const BUN_CHROME_FLAGS = "--remote-debugging-pipe --headless --no-first-run --no-default-browser-check";
const EXIT_DEADLINE_MS = 5_000;
const EXIT_POLL_MS = 25;
// Measured on a loaded macOS host (Chrome 155): Browser.close to browser exit took 74-2,356 ms.
const GRACEFUL_EXIT_MS = 5_000;
const TERM_EXIT_MS = 2_000;

function run(file: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, [...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (_error, stdout) =>
			resolve(String(stdout ?? "")),
		);
	});
}

function positivePids(texts: readonly string[]): number[] {
	return texts.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

// Bun's Chrome browsers and every process under them, from one CIM listing (see windows-chrome-tree.ts
// for why a recorded parent pid alone is not proof of parentage).
async function windowsBunChromeKillPlan(): Promise<ChromeKillPlan> {
	const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_ROWS]);
	return bunChromeKillPlan(parseWindowsProcessRows(stdout), process.pid);
}

// A refused kill is written to the CI readiness log, so a wrong adoption shows up as a line instead of a dead runner.
function logSkippedKills(plan: ChromeKillPlan): void {
	const log = process.env.SENPI_WEBVIEW_READINESS_LOG;
	if (log === undefined || log.length === 0) return;
	for (const skip of plan.skipped) {
		appendFileSync(
			log,
			`${new Date().toISOString()} pid=${process.pid} chrome-retire skipped ${skip.name} (${skip.pid}): ${skip.reason}\n`,
		);
	}
}

async function windowsListedPids(): Promise<Set<number>> {
	const stdout = await run("tasklist", ["/FO", "CSV", "/NH"]);
	return new Set(positivePids(stdout.split(/\r?\n/u).map((line) => line.split('","')[1] ?? "")));
}

/**
 * Windows reports a terminated process as gone to `process.kill(pid, 0)` while the process object
 * still exists (Bun holds its child's handle until it reaps it), so the wait is on the process list.
 */
async function waitForWindowsRemoval(pids: readonly number[]): Promise<void> {
	const deadline = Date.now() + EXIT_DEADLINE_MS;
	for (;;) {
		const listed = await windowsListedPids();
		if (!pids.some((pid) => listed.has(pid)) || Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
	}
}

/** A browser Bun launched; `profileDir` is the temp profile Bun made for it (macOS and Linux only). */
export interface BunChromeBrowser {
	readonly pid: number;
	readonly profileDir?: string;
}

async function posixBunChromeBrowsers(): Promise<BunChromeBrowser[]> {
	const browsers: BunChromeBrowser[] = [];
	for (const line of (await run("ps", ["-axo", "pid=,ppid=,command="])).split("\n")) {
		const [pidText = "", ppidText, ...words] = line.trim().split(/\s+/u);
		const command = words.join(" ");
		if (Number(ppidText) !== process.pid || !command.includes(BUN_CHROME_FLAGS)) continue;
		const [pid] = positivePids([pidText]);
		if (pid === undefined) continue;
		const profileDir = bunChromeProfileDir(command);
		browsers.push(profileDir === undefined ? { pid } : { pid, profileDir });
	}
	return browsers;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && Reflect.get(error, "code") === "EPERM";
	}
}

async function waitForExit(pids: readonly number[]): Promise<void> {
	const deadline = Date.now() + EXIT_DEADLINE_MS;
	let remaining = pids.filter(alive);
	while (remaining.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
		remaining = remaining.filter(alive);
	}
}

// A zombie keeps no command line, so a dead browser child is recognized by its name alone.

async function deadBrowserChildren(): Promise<number[]> {
	if (process.platform === "win32") return [];
	const pids: string[] = [];
	for (const line of (await run("ps", ["-axo", "pid=,ppid=,stat=,comm="])).split("\n")) {
		const [pidText = "", ppidText, stat = "", ...command] = line.trim().split(/\s+/u);
		if (Number(ppidText) === process.pid && stat.startsWith("Z") && BROWSER_IMAGE.test(command.join(" ")))
			pids.push(pidText);
	}
	return positivePids(pids);
}

/**
 * Resolves once no killed-but-unreaped Chrome child is left (bounded). A Chrome that died (crash,
 * kill) stays a zombie until Bun reaps it, and Chrome's profile lock still names that pid, so a
 * Chrome Bun launches in that window exits at once ("Chrome process closed the pipe").
 */
export async function settleDeadBunChrome(): Promise<void> {
	await waitForExit(await deadBrowserChildren());
}

// Windows has no WebKit backend, so `closeAll()` can only end Chrome, but it returns while the
// browser and its helpers still run (measured: the whole tree alive 250 ms later, part of it after
// 1.25 s), and a Chrome launched meanwhile finds the profile locked ("Chrome process closed the
// pipe"). So the tree is listed first, ended as a whole, and awaited.
async function killWindowsBunChromeTree(webViewClass: NativeWebViewClass): Promise<void> {
	const plan = await windowsBunChromeKillPlan();
	webViewClass.closeAll();
	const running = plan.kill.filter(alive);
	if (running.length > 0) await run("taskkill", ["/F", ...running.flatMap((pid) => ["/PID", String(pid)])]);
	await waitForWindowsRemoval(plan.kill);
	logSkippedKills(plan);
}

/** The process and timing boundary of a retirement; tests substitute it. */
export interface ChromeRetireSeams {
	readonly platform: NodeJS.Platform;
	readonly listBrowsers: () => Promise<readonly BunChromeBrowser[]>;
	readonly alive: (pid: number) => boolean;
	readonly signal: (pid: number, signal: NodeJS.Signals) => void;
	readonly deadline: (ms: number) => AttachDeadline;
	/** Sends CDP `Browser.close`; resolves false once that failed (see `requestBrowserClose`). */
	readonly requestClose: (webViewClass: NativeWebViewClass) => Promise<boolean>;
	readonly killWindowsTree: (webViewClass: NativeWebViewClass) => Promise<void>;
	readonly removeProfile: (dir: string) => Promise<void>;
}

function signalQuietly(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone between the listing and the signal.
	}
}

export function defaultChromeRetireSeams(): ChromeRetireSeams {
	const platform = process.platform;
	return {
		platform,
		listBrowsers:
			platform === "win32"
				? async () => (await windowsBunChromeKillPlan()).kill.map((pid) => ({ pid }))
				: posixBunChromeBrowsers,
		alive,
		signal: signalQuietly,
		deadline: timedDeadline,
		// The control target goes to the native class: a service's class can be instrumented (tests count
		// and stall its launches), and this view is no launch; Bun has one Chrome either way.
		requestClose: (webViewClass) => requestBrowserClose(mainThreadWebViewClass() ?? webViewClass),
		killWindowsTree: killWindowsBunChromeTree,
		removeProfile: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
	};
}

async function exitedBefore(pids: readonly number[], ms: number, seams: ChromeRetireSeams): Promise<boolean> {
	const deadline = seams.deadline(ms);
	try {
		return await exitedWithin(pids, seams.alive, deadline);
	} finally {
		deadline.cancel();
	}
}

/** Asks Chrome to quit over CDP and waits (bounded) for it; a refused request ends the wait at once. */
async function quitGracefully(
	webViewClass: NativeWebViewClass,
	pids: readonly number[],
	seams: ChromeRetireSeams,
): Promise<void> {
	const grace = seams.deadline(GRACEFUL_EXIT_MS);
	const refused = seams.requestClose(webViewClass).then(() => undefined);
	try {
		await exitedWithin(pids, seams.alive, { reached: Promise.race([grace.reached, refused]), cancel: grace.cancel });
	} finally {
		grace.cancel();
	}
}

async function endBySignal(pids: readonly number[], seams: ChromeRetireSeams): Promise<void> {
	const left = pids.filter(seams.alive);
	if (left.length === 0) return;
	for (const pid of left) seams.signal(pid, "SIGTERM");
	if (await exitedBefore(left, TERM_EXIT_MS, seams)) return;
	for (const pid of left.filter(seams.alive)) seams.signal(pid, "SIGKILL");
	await exitedBefore(left, EXIT_DEADLINE_MS, seams);
}

/**
 * Ends the Chrome Bun spawned once no proxied view needs it; the next Chrome-backed view respawns it.
 * Chrome is first asked to quit over CDP `Browser.close` (senpi#4174: only a graceful quit lets macOS
 * Chrome delete its `code_sign_clone`), and only a Chrome still running after the bound is killed:
 * on Windows by the tree kill, elsewhere by SIGTERM then SIGKILL. `WebView.closeAll()` is not used on
 * macOS, where it also kills the shared WebKit host that native worker views run on. Resolves once
 * those processes are gone (bounded) and their temp profiles removed, so a released kernel leaves no
 * Chrome behind.
 */
export async function retireBunChrome(
	webViewClass: NativeWebViewClass,
	seams: ChromeRetireSeams = defaultChromeRetireSeams(),
): Promise<void> {
	const browsers = await seams.listBrowsers();
	const pids = browsers.map((browser) => browser.pid);
	const running = pids.filter(seams.alive);
	if (running.length > 0) await quitGracefully(webViewClass, running, seams);
	if (seams.platform === "win32") {
		await seams.killWindowsTree(webViewClass);
		return;
	}
	if (seams.platform !== "darwin") webViewClass.closeAll();
	await endBySignal(pids, seams);
	if (pids.some(seams.alive)) return;
	for (const browser of browsers) if (browser.profileDir) await seams.removeProfile(browser.profileDir);
}
