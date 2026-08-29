import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #3592: no-builtin-tools keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// The bundled codemode extension (contributes an `eval` tool) and the terminal builtin
		// (PTY `bash` + companion tools) are both default-on. Disable both via the real
		// global-settings mechanism so this regression's tool-name assertions stay scoped to the
		// built-in defaults and the inline extension it registers.
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ disabledBuiltinExtensions: ["codemode", "terminal"] })}\n`,
		);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noSkills: true,
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((extension) => extension.path === "<inline:1>"),
			}),
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
		});
		await session.bindExtensions({});
		return session;
	}

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "dynamic_tool", "edit", "find", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["dynamic_tool"]);
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("still disables all tools when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("## Available Tools\n\n(none)");
		session.dispose();
	});

	it("propagates noTools through service-based session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});

		expect(session.getActiveToolNames()).toEqual([
			"apply_patch",
			"generate_image",
			"todo",
			"web_search",
			"webfetch",
			"read_video",
			"look_at",
			"create_goal",
			"update_goal",
			"get_goal",
			"schedule_wakeup",
		]);
		expect(session.systemPrompt).toContain("- todo:");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});
});
