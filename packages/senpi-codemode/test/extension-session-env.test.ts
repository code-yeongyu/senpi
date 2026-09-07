import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, expect, it } from "vitest";
import type { CodemodeSessionManager, CreateCodemodeSessionManagerOptions } from "../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

interface RegisteredHandler {
	readonly event: string;
	readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
}

class SessionEnvPi implements CodemodeExtensionAPI {
	readonly handlers: RegisteredHandler[] = [];
	registerTool(): void {}
	registerRemovedToolHint(): void {}
	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}
	executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
	getActiveTools(): string[] {
		return ["eval"];
	}
	getAllTools(): readonly { readonly name: string }[] {
		return [{ name: "eval" }];
	}
	sendMessage(): void {}
	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		for (const entry of this.handlers.filter((handler) => handler.event === event)) {
			await entry.handler(payload, ctx);
		}
	}
}

class CapturedOptionsManager implements CodemodeSessionManager {
	async getKernel(): Promise<never> {
		throw new Error("kernel execution was not expected");
	}
	async dispose(): Promise<void> {}
	async complete(): Promise<{
		readonly text: string;
		readonly details: { readonly model: string; readonly structured: false };
	}> {
		return { text: "ok", details: { model: "fake/fake-model", structured: false } };
	}
}

const artifactsRoot = join(tmpdir(), `senpi-codemode-session-env-tests-${process.pid}`);
const directories: string[] = [];

afterAll(async () => {
	await rm(artifactsRoot, { recursive: true, force: true });
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function sessionContext(
	sessionId: string,
	sessionFile: string | undefined,
	modelId: string,
	cwd: string,
): ExtensionContext {
	const base = fakeExtensionContext();
	const model: Model<Api> = {
		id: modelId,
		name: modelId,
		api: "fake-api",
		provider: "fake",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	return {
		...base,
		cwd,
		sessionManager: {
			...base.sessionManager,
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
		model,
		...(sessionFile === undefined ? {} : { thinkingLevel: "high" as const }),
	};
}

async function sessionCwd(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-session-env-"));
	directories.push(cwd);
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	return cwd;
}

describe("codemode extension session environment", () => {
	it("resolves the session environment from the session context on every session start", async () => {
		const cwd = await sessionCwd();
		const pi = new SessionEnvPi();
		const captured: CreateCodemodeSessionManagerOptions[] = [];
		senpiCodemode(pi, {
			createSessionManager: (options) => {
				captured.push(options);
				return new CapturedOptionsManager();
			},
		});

		await pi.emit(
			"session_start",
			{ reason: "startup", sessionId: "extension-session-a" },
			sessionContext("extension-session-a", join(artifactsRoot, "session-a.jsonl"), "fake-model-a", cwd),
		);
		await pi.emit(
			"session_before_switch",
			{},
			sessionContext("extension-session-a", join(artifactsRoot, "session-a.jsonl"), "fake-model-a", cwd),
		);
		await pi.emit(
			"session_start",
			{ reason: "startup", sessionId: "extension-session-b" },
			sessionContext("extension-session-b", undefined, "fake-model-b", cwd),
		);

		expect(captured).toHaveLength(2);
		expect(captured[0]?.sessionId).toBe("extension-session-a");
		expect(captured[0]?.sessionEnv).toEqual({
			PI_SESSION_ID: "extension-session-a",
			PI_SESSION_FILE: join(artifactsRoot, "session-a.jsonl"),
			PI_PROVIDER: "fake",
			PI_MODEL: "fake-model-a",
			PI_REASONING_LEVEL: "high",
		});
		expect(captured[1]?.sessionId).toBe("extension-session-b");
		expect(captured[1]?.sessionEnv).toEqual({
			PI_SESSION_ID: "extension-session-b",
			PI_PROVIDER: "fake",
			PI_MODEL: "fake-model-b",
		});
	});
});
