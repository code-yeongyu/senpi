import { execFile } from "node:child_process";
import type { NativeWebViewClass } from "./native-webview.ts";

// Bun launches its Chrome with exactly this default flag run (see `Bun.WebView` backend docs);
// together with the parent pid it tells Bun's browser apart from any other Chrome we spawned.
const BUN_CHROME_FLAGS = "--remote-debugging-pipe --headless --no-first-run --no-default-browser-check";
const EXIT_DEADLINE_MS = 5_000;
const EXIT_POLL_MS = 25;

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

// Bun's Chrome browsers (direct children with Bun's flags) and every process under them, in one
// CIM listing; the listing's own PowerShell is excluded because its command line names the flag.
const WINDOWS_CHROME_TREE = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine
$tree = [System.Collections.Generic.HashSet[int]]::new()
foreach ($p in $all) { if ($p.ParentProcessId -eq ${process.pid} -and $p.ProcessId -ne $PID -and $p.CommandLine -like '*--remote-debugging-pipe*') { [void]$tree.Add([int]$p.ProcessId) } }
do { $grew = $false; foreach ($p in $all) { if ($tree.Contains([int]$p.ParentProcessId) -and $tree.Add([int]$p.ProcessId)) { $grew = $true } } } while ($grew)
$tree`;

async function windowsBunChromeTree(): Promise<number[]> {
	const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CHROME_TREE]);
	return positivePids(stdout.split(/\r?\n/u).map((line) => line.trim()));
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

async function bunChromePids(): Promise<number[]> {
	const pids: string[] = [];
	for (const line of (await run("ps", ["-axo", "pid=,ppid=,command="])).split("\n")) {
		const [pidText = "", ppidText, ...command] = line.trim().split(/\s+/u);
		if (Number(ppidText) === process.pid && command.join(" ").includes(BUN_CHROME_FLAGS)) pids.push(pidText);
	}
	return positivePids(pids);
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
const BROWSER_NAME = /chrom|msedge|brave/iu;

async function deadBrowserChildren(): Promise<number[]> {
	if (process.platform === "win32") return [];
	const pids: string[] = [];
	for (const line of (await run("ps", ["-axo", "pid=,ppid=,stat=,comm="])).split("\n")) {
		const [pidText = "", ppidText, stat = "", ...command] = line.trim().split(/\s+/u);
		if (Number(ppidText) === process.pid && stat.startsWith("Z") && BROWSER_NAME.test(command.join(" ")))
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

/**
 * Ends the Chrome Bun spawned once no proxied view needs it; the next Chrome-backed view respawns it.
 * `WebView.closeAll()` would do this, but on macOS it also kills the shared WebKit host that native
 * worker views (the macOS default backend) run on, so there only Bun's own Chrome child is killed.
 * Resolves once those processes are gone (bounded), so a released kernel leaves no Chrome behind.
 */
export async function retireBunChrome(webViewClass: NativeWebViewClass): Promise<void> {
	// Windows has no WebKit backend, so `closeAll()` can only end Chrome, but it returns while the
	// browser and its helpers still run (measured: the whole tree alive 250 ms later, part of it after
	// 1.25 s), and a Chrome launched meanwhile finds the profile locked ("Chrome process closed the
	// pipe"). So the tree is listed first, ended as a whole, and awaited.
	if (process.platform === "win32") {
		const tree = await windowsBunChromeTree();
		webViewClass.closeAll();
		const running = tree.filter(alive);
		if (running.length > 0) await run("taskkill", ["/F", ...running.flatMap((pid) => ["/PID", String(pid)])]);
		await waitForWindowsRemoval(tree);
		return;
	}
	const pids = await bunChromePids();
	if (process.platform === "darwin") {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone between the listing and the kill.
			}
		}
	} else {
		webViewClass.closeAll();
	}
	await waitForExit(pids);
}
