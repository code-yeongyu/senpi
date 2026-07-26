import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, vi } from "vitest";
import { restoreStdout } from "../../src/core/output-guard.ts";
import { runAppServerMode } from "../../src/modes/app-server/index.ts";
import { captureStderrPort } from "./app-server-mode-socket.ts";

const runningModes: Array<Promise<void>> = [];
const roots: string[] = [];
const QA_PORTS = [18990, 18991, 18992, 18993, 18994, 18995, 18996, 18997, 18998, 18999] as const;

export type QaPort = (typeof QA_PORTS)[number];

export type RunningAppServerMode = {
	readonly mode: Promise<void>;
	readonly port: number;
	readonly banner: { restore(): void };
};

afterEach(async () => {
	if (runningModes.length > 0) {
		process.emit("SIGTERM", "SIGTERM");
	}
	await Promise.allSettled(runningModes.splice(0));
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
	restoreStdout();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

export async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-mode-"));
	roots.push(root);
	return root;
}

export function configureModeEnv(root: string): void {
	vi.stubEnv("SENPI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("SENPI_CODING_AGENT_SESSION_DIR", join(root, "sessions"));
	vi.stubEnv("PI_OFFLINE", "1");
	vi.spyOn(process, "exit").mockImplementation(exitThrows);
}

export async function startWsAppServerMode(preferredPort: QaPort): Promise<RunningAppServerMode> {
	const ports = [preferredPort, ...QA_PORTS.filter((port) => port !== preferredPort)];
	for (const port of ports) {
		const banner = captureStderrPort();
		const mode = runAppServerMode({
			kind: "server",
			listen: {
				kind: "ws",
				url: `ws://127.0.0.1:${port}`,
				host: "127.0.0.1",
				port,
			},
			wsAuth: { kind: "off" },
			jsonLogs: false,
		});
		runningModes.push(mode);
		try {
			const observedPort = await Promise.race([banner.wait, mode.then(() => failModeExited())]);
			expect(observedPort).toBe(port);
			return { mode, port: observedPort, banner };
		} catch (error) {
			runningModes.splice(runningModes.indexOf(mode), 1);
			banner.restore();
			if (!(error instanceof Error) || !/EADDRINUSE|address already in use/.test(error.message)) {
				throw error;
			}
		}
	}
	throw new Error("No app-server QA port is available");
}

export async function stopWsAppServerMode(running: RunningAppServerMode): Promise<void> {
	process.emit("SIGTERM", "SIGTERM");
	await expect(running.mode).resolves.toBeUndefined();
	runningModes.splice(runningModes.indexOf(running.mode), 1);
	running.banner.restore();
}

export async function seedFauxConfig(root: string, faux: ReturnType<typeof registerFauxProvider>): Promise<void> {
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const model = faux.getModel();
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, disabledBuiltinExtensions: [] }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[model.provider]: {
						api: model.api,
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						models: [{ id: model.id, name: model.name, input: model.input }],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

export function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

export async function eventually(assertion: () => void | Promise<void>): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await assertion();
			return;
		} catch (error: unknown) {
			lastError = error;
			await deferOneTick();
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function threadIdFromResponse(response: Record<string, unknown>): string {
	expectRecord(response.result);
	expectRecord(response.result.thread);
	const threadId = response.result.thread.id;
	if (typeof threadId !== "string") {
		throw new Error("thread/start response missing thread id");
	}
	return threadId;
}

export function turnIdFromResponse(response: Record<string, unknown>): string {
	expectRecord(response.result);
	expectRecord(response.result.turn);
	const turnId = response.result.turn.id;
	if (typeof turnId !== "string") {
		throw new Error("turn/start response missing turn id");
	}
	return turnId;
}

function exitThrows(code?: string | number | null): never {
	throw new Error(`process.exit ${String(code)}`);
}

function failModeExited(): never {
	throw new Error("app-server mode exited before startup");
}

function deferOneTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected object");
	}
}
