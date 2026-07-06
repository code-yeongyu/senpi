import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";

describe("MCP-prefixed extension tool allowlist", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mcp-prefix-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an explicitly allowlisted mcp_ extension tool active after builtin MCP startup", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "mcp_fx_tool_1",
					label: "MCP fixture tool",
					description: "MCP-style tool registered by an explicit extension",
					parameters: Type.Object({
						value: Type.Optional(Type.String()),
					}),
					execute: async () => ({
						content: [{ type: "text", text: "fixture tool_1 value=ok mode=alpha" }],
						details: {},
					}),
				});
			},
		];
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			agentDir,
			cwd: tempDir,
			extensionFactories,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			agentDir,
			cwd: tempDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			resourceLoader,
			sessionManager,
			settingsManager,
			tools: ["mcp_fx_tool_1"],
		});

		try {
			await session.bindExtensions({});

			expect(session.getActiveToolNames()).toEqual(["mcp_fx_tool_1"]);
		} finally {
			session.dispose();
		}
	});
});
