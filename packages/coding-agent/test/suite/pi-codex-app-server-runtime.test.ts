import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPiCodexAppServerRuntime,
	type PiCodexAppServerRuntime,
	type PiCodexAppServerWebSocketLike,
} from "../../src/core/extensions/builtin/pi-codex-app-server/transport-runtime.ts";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

function createTempRoot(): string {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-runtime-test-"));
	tempRoots.push(tempRoot);
	return tempRoot;
}

function createLongRunningScript(): string {
	const tempRoot = createTempRoot();
	const scriptPath = join(tempRoot, "fake-app-server.mjs");
	writeFileSync(
		scriptPath,
		[
			"process.stdout.write('ready\\n');",
			"process.on('SIGTERM', () => process.exit(0));",
			"setInterval(() => undefined, 1000);",
		].join("\n"),
	);
	return scriptPath;
}

function createArgumentRecorderScript(outputPath: string): string {
	const tempRoot = createTempRoot();
	const scriptPath = join(tempRoot, "record-args.sh");
	writeFileSync(
		scriptPath,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$@" > ${JSON.stringify(outputPath)}`,
			"trap 'exit 0' TERM",
			"while true; do sleep 1; done",
		].join("\n"),
	);
	chmodSync(scriptPath, 0o755);
	return scriptPath;
}

function createExitingScript(exitCode: number): string {
	const tempRoot = createTempRoot();
	const scriptPath = join(tempRoot, "exit-now.mjs");
	writeFileSync(scriptPath, `process.exit(${exitCode});\n`);
	return scriptPath;
}

class FakeWebSocket implements PiCodexAppServerWebSocketLike {
	readonly url: string;
	readyState = 0;
	private readonly listeners = new Map<string, Set<() => void>>();

	constructor(url: string, options: { readonly open: boolean } = { open: true }) {
		this.url = url;
		if (options.open) {
			queueMicrotask(() => {
				this.readyState = 1;
				this.emit("open");
			});
		}
	}

	addEventListener(
		type: "open" | "error" | "close",
		listener: () => void,
		options?: { readonly once?: boolean },
	): void {
		const wrapped = options?.once
			? () => {
					this.removeEventListener(type, wrapped);
					listener();
				}
			: listener;
		const listeners = this.listeners.get(type) ?? new Set<() => void>();
		listeners.add(wrapped);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: "open" | "error" | "close", listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close");
	}

	closeUnexpectedly(): void {
		this.readyState = 3;
		this.emit("close");
	}

	private emit(type: "open" | "error" | "close"): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener();
		}
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!existsSync(path)) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${path}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("pi-codex-app-server runtime transport", () => {
	it("starts a child-process stdio app-server and stops it cleanly", async () => {
		const runtime = createPiCodexAppServerRuntime();
		const scriptPath = createLongRunningScript();

		const started = await runtime.start({
			enabled: true,
			mode: "stdio",
			appServerCommand: process.execPath,
			appServerArgs: [scriptPath],
			appServerUrl: "",
			connectTimeoutMs: 1000,
		});
		const stopped = await runtime.stop();

		expect(started).toMatchObject({ kind: "running", mode: "stdio" });
		expect(stopped).toEqual({ kind: "stopped" });
		expect(runtime.getStatus()).toEqual({ kind: "stopped" });
	});

	it.each([42, 0])("marks runtime failed when a stdio child exits with code %s before shutdown", async (exitCode) => {
		const runtime = createPiCodexAppServerRuntime();
		const scriptPath = createExitingScript(exitCode);

		const started = await runtime.start({
			enabled: true,
			mode: "stdio",
			appServerCommand: process.execPath,
			appServerArgs: [scriptPath],
			appServerUrl: "",
			connectTimeoutMs: 1000,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(started).toMatchObject({ kind: "running", mode: "stdio" });
		expect(runtime.getStatus()).toMatchObject({
			kind: "failed",
			mode: "stdio",
			message: `stdio app-server process exited unexpectedly with code ${exitCode}.`,
		});
	});

	it("opens and closes a websocket app-server transport for health setup", async () => {
		const openedUrls: string[] = [];
		const runtime: PiCodexAppServerRuntime = createPiCodexAppServerRuntime({
			createWebSocket: (url) => {
				openedUrls.push(url);
				return new FakeWebSocket(url);
			},
		});

		const started = await runtime.start({
			enabled: true,
			mode: "websocket",
			appServerCommand: "",
			appServerArgs: [],
			appServerUrl: "ws://127.0.0.1:7654",
			connectTimeoutMs: 1000,
		});
		const stopped = await runtime.stop();

		expect(started).toMatchObject({ kind: "running", mode: "websocket" });
		expect(stopped).toEqual({ kind: "stopped" });
		expect(openedUrls).toEqual(["ws://127.0.0.1:7654"]);
	});

	it("marks runtime failed when websocket closes unexpectedly after setup", async () => {
		let socket: FakeWebSocket | undefined;
		const runtime = createPiCodexAppServerRuntime({
			createWebSocket: (url) => {
				socket = new FakeWebSocket(url);
				return socket;
			},
		});

		const started = await runtime.start({
			enabled: true,
			mode: "websocket",
			appServerCommand: "",
			appServerArgs: [],
			appServerUrl: "ws://127.0.0.1:7654",
			connectTimeoutMs: 1000,
		});
		socket?.closeUnexpectedly();

		expect(started).toMatchObject({ kind: "running", mode: "websocket" });
		expect(runtime.getStatus()).toMatchObject({
			kind: "failed",
			mode: "websocket",
			message: "WebSocket closed unexpectedly.",
		});
	});

	it("records failed status when websocket setup times out", async () => {
		const runtime = createPiCodexAppServerRuntime({
			createWebSocket: (url) => new FakeWebSocket(url, { open: false }),
		});

		const started = await runtime.start({
			enabled: true,
			mode: "websocket",
			appServerCommand: "",
			appServerArgs: [],
			appServerUrl: "ws://127.0.0.1:7654",
			connectTimeoutMs: 10,
		});

		expect(started).toMatchObject({
			kind: "failed",
			mode: "websocket",
			message: "WebSocket connect timeout after 10ms.",
		});
		expect(runtime.getStatus()).toEqual(started);
	});

	it("uses codex app-server proxy arguments for unix socket transport", async () => {
		const runtime = createPiCodexAppServerRuntime();
		const tempRoot = createTempRoot();
		const outputPath = join(tempRoot, "argv.json");
		const socketPath = join(tempRoot, "codex.sock");
		const scriptPath = createArgumentRecorderScript(outputPath);

		const started = await runtime.start({
			enabled: true,
			mode: "unix",
			appServerCommand: scriptPath,
			appServerArgs: [],
			appServerUrl: "",
			appServerSocketPath: socketPath,
			connectTimeoutMs: 1000,
		});
		await waitForFile(outputPath);
		const stopped = await runtime.stop();

		expect(started).toMatchObject({ kind: "running", mode: "unix" });
		expect(stopped).toEqual({ kind: "stopped" });
		expect(readFileSync(outputPath, "utf-8").trim().split("\n")).toEqual([
			"app-server",
			"proxy",
			"--sock",
			socketPath,
		]);
	});
});
