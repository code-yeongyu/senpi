import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";

type SentMessage = RpcEnvelope;

describe("app-server config reads", () => {
	it("maps only the pinned settings and reports user/project layers", async () => {
		// Given: global and project settings with both mappable and unrelated values.
		const root = await mkdtemp(join(tmpdir(), "senpi-app-server-config-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectConfigDir = join(projectDir, ".senpi");
		await mkdir(agentDir, { recursive: true });
		await mkdir(projectConfigDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "global-provider",
				defaultModel: "global-model",
				defaultThinkingLevel: "low",
				theme: "global-only",
			}),
		);
		await writeFile(
			join(projectConfigDir, "settings.json"),
			JSON.stringify({ defaultModel: "project-model", theme: "project-only" }),
		);
		const current = createCore(agentDir, root);

		try {
			await initialize(current.core, current.id);

			// When: config/read resolves the project settings at cwd with layers enabled.
			await current.core.receive(current.id, request(2, "config/read", { cwd: projectDir, includeLayers: true }));

			// Then: only the pinned snake_case fields are emitted, with honest origins and layers.
			expect(current.sent[1]).toEqual({
				id: 2,
				result: {
					config: {
						model: "project-model",
						model_provider: "global-provider",
						approval_policy: "never",
						sandbox_mode: "danger-full-access",
						model_reasoning_effort: "low",
					},
					origins: {
						model: {
							name: { type: "project", dotCodexFolder: projectConfigDir },
							version: expect.any(String),
						},
						model_provider: {
							name: { type: "user", file: join(agentDir, "settings.json"), profile: null },
							version: expect.any(String),
						},
						model_reasoning_effort: {
							name: { type: "user", file: join(agentDir, "settings.json"), profile: null },
							version: expect.any(String),
						},
					},
					layers: [
						expect.objectContaining({
							name: { type: "user", file: join(agentDir, "settings.json"), profile: null },
							config: {
								model: "global-model",
								model_provider: "global-provider",
								model_reasoning_effort: "low",
							},
						}),
						expect.objectContaining({
							name: { type: "project", dotCodexFolder: projectConfigDir },
							config: { model: "project-model" },
						}),
					],
				},
			});
			expect(Object.keys(resultOf(current.sent[1], 2).config).sort()).toEqual([
				"approval_policy",
				"model",
				"model_provider",
				"model_reasoning_effort",
				"sandbox_mode",
			]);
			expect(resultOf(current.sent[1], 2).config).not.toHaveProperty("theme");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("selects project settings by cwd and returns empty requirements", async () => {
		// Given: two project directories with different project defaults and no requirements source.
		const root = await mkdtemp(join(tmpdir(), "senpi-app-server-config-cwd-"));
		const agentDir = join(root, "agent");
		const firstProject = join(root, "first");
		const secondProject = join(root, "second");
		await mkdir(join(agentDir), { recursive: true });
		await mkdir(join(firstProject, ".senpi"), { recursive: true });
		await mkdir(join(secondProject, ".senpi"), { recursive: true });
		await writeFile(join(firstProject, ".senpi", "settings.json"), JSON.stringify({ defaultModel: "first-model" }));
		await writeFile(join(secondProject, ".senpi", "settings.json"), JSON.stringify({ defaultModel: "second-model" }));
		const current = createCore(agentDir, root);

		try {
			await initialize(current.core, current.id);

			// When: config/read is called for each cwd and configRequirements/read is called without params.
			await current.core.receive(current.id, request(2, "config/read", { cwd: firstProject }));
			await current.core.receive(current.id, request(3, "config/read", { cwd: secondProject }));
			await current.core.receive(current.id, request(4, "configRequirements/read", undefined));

			// Then: each cwd selects its own project model and requirements remain null.
			expect(resultOf(current.sent[1], 2).config.model).toBe("first-model");
			expect(resultOf(current.sent[2], 3).config.model).toBe("second-model");
			expect(current.sent[3]).toEqual({ id: 4, result: { requirements: null } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function createCore(
	agentDir: string,
	serverCwd: string,
): {
	readonly core: ServerCore;
	readonly sent: SentMessage[];
	readonly id: string;
} {
	const core = new ServerCore({ codexHome: agentDir, serverCwd, version: "2026.7.2" });
	const sent: SentMessage[] = [];
	const connection = core.addConnection({
		id: "config-test",
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});
	return { core, sent, id: connection.id };
}

async function initialize(core: ServerCore, id: string): Promise<void> {
	await core.receive(
		id,
		request(1, "initialize", {
			clientInfo: { name: "config-test", title: "Config Test", version: "0.0.1" },
			capabilities: { experimentalApi: false, requestAttestation: false },
		}),
	);
}

function request(
	id: number,
	method: string,
	params: unknown,
): {
	readonly kind: "request";
	readonly message: { readonly id: number; readonly method: string; readonly params: unknown };
} {
	return { kind: "request", message: { id, method, params } };
}

function resultOf(
	message: SentMessage | undefined,
	id: number,
): {
	readonly config: Record<string, unknown>;
} {
	expect(message).toEqual({ id, result: expect.anything() });
	if (message !== undefined && "result" in message && isRecord(message.result) && isRecord(message.result.config)) {
		return { config: message.result.config };
	}
	throw new Error("expected config/read success response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
