import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kimiSessionConfigOptions } from "../src/core/extensions/builtin/kimi-sdk/sdk-boundary.ts";
import { nativeAgentEnvironment, runAcpAgent } from "../src/core/extensions/builtin/native-agent-sdk/acp-boundary.ts";
import {
	nativeAgentPermissionTarget,
	registerNativeAgentPermissionHandler,
	requestNativeAgentPermission,
} from "../src/core/extensions/builtin/native-agent-sdk/permission.ts";
import { createBuiltinParserRegistry } from "../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../src/core/extensions/builtin/permission-system/service.ts";
import { DeniedError } from "../src/core/extensions/builtin/permission-system/types.ts";
import {
	naturalExitWithDescendantAgentScript,
	permissionMetadataAgentScript,
	streamingAgentScript,
} from "./helpers/native-agent-sdk.ts";

describe("native agent ACP boundary", () => {
	it("passes only runtime and provider-specific credential variables", () => {
		const environment = nativeAgentEnvironment(["XAI_API_KEY"], {
			PATH: "/bin",
			HOME: "/home/test",
			XAI_API_KEY: "xai-test",
			OPENAI_API_KEY: "must-not-leak",
			AWS_SECRET_ACCESS_KEY: "must-not-leak",
		});

		expect(environment).toEqual({
			PATH: "/bin",
			HOME: "/home/test",
			XAI_API_KEY: "xai-test",
		});
	});

	it("surfaces a missing ACP executable as a rejected turn", async () => {
		const collect = async (): Promise<void> => {
			for await (const _event of runAcpAgent(
				{ provider: "test-sdk", model: "test-model", prompt: "test", cwd: process.cwd() },
				"senpi-definitely-missing-acp-command",
				[],
				"senpi-test",
				[],
			)) {
			}
		};

		await expect(collect()).rejects.toThrow();
	});

	it("rejects a pre-aborted request before spawning the runtime", async () => {
		const controller = new AbortController();
		controller.abort();
		const collect = async (): Promise<void> => {
			for await (const _event of runAcpAgent(
				{
					provider: "test-sdk",
					model: "test-model",
					prompt: "test",
					cwd: process.cwd(),
					signal: controller.signal,
				},
				"senpi-command-must-not-spawn",
				[],
				"senpi-test",
				[],
			)) {
			}
		};

		await expect(collect()).rejects.toThrow("Operation aborted");
	});

	it("routes native tool approval through the registered Senpi session permission handler", async () => {
		const unregister = registerNativeAgentPermissionHandler("session-1", async (request) => {
			expect(request).toMatchObject({
				provider: "grok-sdk",
				kind: "execute",
				title: "Run tests",
			});
			return true;
		});

		try {
			await expect(
				requestNativeAgentPermission("session-1", {
					provider: "grok-sdk",
					kind: "execute",
					title: "Run tests",
				}),
			).resolves.toBe(true);
			await expect(
				requestNativeAgentPermission("missing-session", {
					provider: "grok-sdk",
					kind: "execute",
					title: "Run tests",
				}),
			).resolves.toBe(false);
		} finally {
			unregister();
		}
	});

	it("maps ACP execute requests into the existing bash permission class", async () => {
		const target = nativeAgentPermissionTarget({
			provider: "grok-sdk",
			kind: "execute",
			title: "Delete generated files",
			rawInput: { command: "rm -rf generated" },
		});
		const [permissionRequest] = createBuiltinParserRegistry().parse(target.toolName, target.input, process.cwd());
		if (permissionRequest === undefined) throw new Error("Expected a native bash permission request");
		const service = new PermissionService([{ permission: "bash", pattern: "*", action: "deny" }], []);

		expect(target).toEqual({
			toolName: "bash",
			input: { command: "rm -rf generated" },
		});
		await expect(
			service.ask({
				sessionID: "session-1",
				...permissionRequest,
				metadata: target.input,
			}),
		).rejects.toEqual(new DeniedError(["rm"]));
	});

	it("uses streamed tool metadata when ACP permission requests omit kind and raw input", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-acp-permission-"));
		const rejectionMarker = join(cwd, "rejected");
		const fakeAgent = permissionMetadataAgentScript(rejectionMarker);
		let capturedRequest: unknown;
		const unregister = registerNativeAgentPermissionHandler("senpi-session", async (request) => {
			capturedRequest = request;
			return false;
		});

		try {
			for await (const _event of runAcpAgent(
				{
					provider: "kimi-sdk",
					model: "k3",
					prompt: "test",
					cwd,
					sessionId: "senpi-session",
				},
				process.execPath,
				["--input-type=module", "-e", fakeAgent],
				"senpi-test",
				[],
			)) {
			}
			expect(capturedRequest).toMatchObject({
				provider: "kimi-sdk",
				kind: "edit",
				title: "Write",
				rawInput: { path: "proof.txt", content: "blocked" },
			});
			expect(existsSync(rejectionMarker)).toBe(true);
		} finally {
			unregister();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("forwards ACP text chunks before the prompt turn completes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-acp-stream-"));
		const completionMarker = join(cwd, "completed");
		const fakeAgent = streamingAgentScript(completionMarker);

		try {
			const iterator = runAcpAgent(
				{ provider: "test-sdk", model: "test-model", prompt: "test", cwd },
				process.execPath,
				["--input-type=module", "-e", fakeAgent],
				"senpi-test",
				[],
			)[Symbol.asyncIterator]();

			await expect(iterator.next()).resolves.toEqual({
				value: { type: "text", text: "first" },
				done: false,
			});
			expect(existsSync(completionMarker)).toBe(false);
			await expect(iterator.next()).resolves.toEqual({
				value: { type: "text", text: "second" },
				done: false,
			});
			expect(existsSync(completionMarker)).toBe(true);
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reaps ACP descendants when the runtime exits after a completed turn", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-acp-natural-exit-"));
		const descendantPidMarker = join(cwd, "descendant-pid");

		try {
			for await (const _event of runAcpAgent(
				{ provider: "test-sdk", model: "test-model", prompt: "test", cwd },
				process.execPath,
				["--input-type=module", "-e", naturalExitWithDescendantAgentScript(descendantPidMarker)],
				"senpi-test",
				[],
			)) {
			}
			const descendantPid = Number(readFileSync(descendantPidMarker, "utf8"));
			expect(() => process.kill(descendantPid, 0)).toThrow();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("maps Senpi reasoning levels to Kimi's ACP thinking option", () => {
		const request = {
			provider: "kimi-sdk",
			model: "k3",
			prompt: "test",
			cwd: process.cwd(),
		};

		expect(kimiSessionConfigOptions(request)).toEqual([]);
		expect(kimiSessionConfigOptions({ ...request, reasoning: "minimal" })).toEqual([
			{ configId: "thinking", value: "low" },
		]);
		expect(kimiSessionConfigOptions({ ...request, reasoning: "high" })).toEqual([
			{ configId: "thinking", value: "high" },
		]);
		expect(kimiSessionConfigOptions({ ...request, reasoning: "max" })).toEqual([
			{ configId: "thinking", value: "max" },
		]);
	});
});
