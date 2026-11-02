import { execFile } from "node:child_process";
import { createServer } from "node:http";

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
