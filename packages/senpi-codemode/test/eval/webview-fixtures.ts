import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, rmdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const FIXTURE_HTML =
	"<!doctype html><title>kernel-webview</title><h1 id='greeting'>hello from the fixture</h1><button id='go' onclick=\"document.title='clicked'\">go</button>";

export const bunWebViewAvailable = ((): boolean => {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	return typeof bun === "object" && bun !== null && typeof Reflect.get(bun, "WebView") === "function";
})();

export interface WebViewFixturePage {
	readonly url: string;
	stop(): Promise<void>;
}

export async function serveFixturePage(): Promise<WebViewFixturePage> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html" });
		response.end(FIXTURE_HTML);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture server has no TCP address");
	return {
		url: `http://127.0.0.1:${address.port}/`,
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Set by webview-warm-up-global-setup.ts: one directory per vitest run, shared by every test file's process. */
export const WEBVIEW_WARM_UP_DIR_ENV = "SENPI_WEBVIEW_WARM_UP_DIR";

// senpi#7147: the run's first Chrome launch, CDP attach and navigation cost far more than any later one, and
// that cost belongs to the machine, not to one process: once it is paid, a fresh test process attaches in
// well under a second. Each WebView file that starts Chrome first pays it in a bounded warm-up, but vitest runs
// files in parallel, so two warm-ups started their cold Chromes at once on a 4-vCPU runner; both launches of one
// of them stalled past the product's attach bound and its file failed. Warm-ups therefore take turns: one
// holds the run's slot at a time, so the cold cost is paid by one Chrome alone and every later warm-up is warm.
// A warm-up waits at most this long for the slot, the largest budget any warm-up hook holds it for.
export const CHROME_WARM_UP_SLOT_WAIT_MS = 140_000;

export async function oneChromeWarmUpAtATime<T>(warmUp: () => Promise<T>): Promise<T> {
	const directory = process.env[WEBVIEW_WARM_UP_DIR_ENV];
	if (!directory) return warmUp();
	const slot = join(directory, "warm-up.slot");
	const waitStartedAt = performance.now();
	await takeSlot(directory, slot);
	const path = process.env.SENPI_WEBVIEW_READINESS_LOG;
	if (path)
		appendFileSync(
			path,
			`${new Date().toISOString()} pid=${process.pid} webview warm-up slot waitedMs=${Math.round(performance.now() - waitStartedAt)}\n`,
		);
	try {
		return await warmUp();
	} finally {
		rmdirSync(slot);
	}
}

/** Creating the slot directory is atomic across processes; a holder removing it wakes the directory's watchers. */
function takeSlot(directory: string, slot: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const watcher = watch(directory);
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			watcher.close();
			if (error) reject(error);
			else resolve();
		};
		const attempt = (): void => {
			if (settled) return;
			try {
				mkdirSync(slot);
				settle();
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
				settle(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const deadline = setTimeout(
			() =>
				settle(
					new Error(`another file's Chrome warm-up still held ${slot} after ${CHROME_WARM_UP_SLOT_WAIT_MS} ms`),
				),
			CHROME_WARM_UP_SLOT_WAIT_MS,
		);
		watcher.on("change", attempt);
		watcher.on("error", settle);
		attempt();
	});
}

function run(file: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, [...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (_error, stdout) =>
			resolve(String(stdout ?? "")),
		);
	});
}

/** Bun-spawned Chrome = a direct child launched with `--remote-debugging-pipe`; one left after teardown is a leak. */
export async function bunChromeChildren(): Promise<number[]> {
	if (process.platform === "win32") {
		const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*--remote-debugging-pipe*' } | ForEach-Object { $_.ProcessId }`;
		const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		return stdout
			.split(/\r?\n/u)
			.map((line) => Number(line.trim()))
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	}
	const stdout = await run("ps", ["-axo", "pid=,ppid=,command="]);
	const pids: number[] = [];
	for (const line of stdout.split("\n")) {
		const [pidText, ppidText, ...command] = line.trim().split(/\s+/u);
		if (Number(ppidText) !== process.pid) continue;
		if (!command.join(" ").includes("--remote-debugging-pipe")) continue;
		pids.push(Number(pidText));
	}
	return pids;
}
