import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withTimeout } from "./with-timeout.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function renderTerminalScreenshot(root, evidence, raw) {
	if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
	const ansiPath = join(evidence, "terminal.ansi");
	const htmlPath = join(evidence, "terminal.html");
	const gridPath = join(evidence, "terminal.grid.json");
	const pngPath = join(evidence, "terminal.png");
	const profileDir = mkdtempSync(join(tmpdir(), "senpi-qa-chrome-"));
	writeFileSync(ansiPath, raw);
	execFileSync(
		process.execPath,
		[
			join(root, "scripts", "qa", "xterm-render.mjs"),
			"render",
			ansiPath,
			"--cols",
			"120",
			"--rows",
			"36",
			"--out-json",
			gridPath,
			"--out-html",
			htmlPath,
			"--title",
			"Senpi cache-warm TUI",
		],
		{ cwd: root, stdio: "inherit" },
	);
	const chrome = spawn(
		CHROME,
		[
			"--headless=new",
			"--disable-background-networking",
			"--disable-extensions",
			"--disable-gpu",
			"--hide-scrollbars",
			"--no-default-browser-check",
			"--no-first-run",
			`--user-data-dir=${profileDir}`,
			"--remote-debugging-port=0",
			"--window-size=1400,900",
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	try {
		const port = await devToolsPort(chrome);
		const targets = await withTimeout(
			fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()),
			"Chrome target list",
			10_000,
		);
		const page = targets.find((target) => target.type === "page");
		if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page target");
		const cdp = await connectCdp(page.webSocketDebuggerUrl);
		try {
			await cdp.send("Runtime.enable");
			await cdp.send("Page.enable");
			const loaded = cdp.waitFor("Page.loadEventFired");
			await cdp.send("Page.navigate", { url: pathToFileURL(htmlPath).href });
			await loaded;
			const screenshot = await cdp.send("Page.captureScreenshot", {
				format: "png",
				fromSurface: true,
				captureBeyondViewport: false,
			});
			writeFileSync(pngPath, Buffer.from(screenshot.data, "base64"));
		} finally {
			cdp.close();
		}
	} finally {
		await stopProcess(chrome);
		rmSync(profileDir, { recursive: true, force: true });
	}
	if (!existsSync(pngPath) || statSync(pngPath).size === 0) {
		throw new Error("Chrome did not produce terminal.png");
	}
}

function devToolsPort(chrome) {
	return withTimeout(
		new Promise((resolve, reject) => {
			let stderr = "";
			chrome.once("error", reject);
			chrome.stderr.setEncoding("utf8");
			chrome.stderr.on("data", (chunk) => {
				stderr += chunk;
				const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
				if (match) resolve(Number(match[1]));
			});
			chrome.once("exit", (code) => reject(new Error(`Chrome exited before DevTools startup (${code})`)));
		}),
		"Chrome DevTools startup",
		15_000,
	);
}

async function connectCdp(url) {
	const socket = new WebSocket(url);
	await withTimeout(
		new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		}),
		"Chrome DevTools socket",
		10_000,
	);
	let sequence = 0;
	const pending = new Map();
	const eventWaiters = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const eventWaiter = message.method ? eventWaiters.get(message.method) : undefined;
		if (eventWaiter) {
			eventWaiters.delete(message.method);
			eventWaiter(message.params);
		}
		if (!message.id) return;
		const commandWaiter = pending.get(message.id);
		if (!commandWaiter) return;
		pending.delete(message.id);
		if (message.error) commandWaiter.reject(new Error(message.error.message));
		else commandWaiter.resolve(message.result);
	});
	return {
		send(method, params = {}) {
			return withTimeout(
				new Promise((resolve, reject) => {
					const id = ++sequence;
					pending.set(id, { resolve, reject });
					socket.send(JSON.stringify({ id, method, params }));
				}),
				`Chrome command ${method}`,
				15_000,
			);
		},
		waitFor(method) {
			return withTimeout(
				new Promise((resolve) => {
					eventWaiters.set(method, resolve);
				}),
				`Chrome event ${method}`,
				15_000,
			);
		},
		close() {
			socket.close();
		},
	};
}

async function stopProcess(child) {
	if (child.exitCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	try {
		await withTimeout(exited, "Chrome shutdown", 5_000);
	} catch {
		child.kill("SIGKILL");
		await withTimeout(exited, "Chrome forced shutdown", 5_000);
	}
}

