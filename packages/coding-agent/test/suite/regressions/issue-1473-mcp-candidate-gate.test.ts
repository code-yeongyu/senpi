import { AsyncResource } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import {
	installMcpNativeToolSearchGate,
	isMcpNativeToolSearchEnabled,
} from "../../../src/core/extensions/builtin/tool-search/native-search.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { Extension } from "../../../src/core/extensions/types.ts";

// Created before any gate installation: runInAsyncScope reads the process fallback, not an inherited gate.
const independent = new AsyncResource("pr1473-independent-gate");

// PR #1473 ghN2J: actual scoped services, real config load and extension attachment, no gate mocks.
it.each([true, false])(
	"PR1473 ghN2J: discarded candidates preserve the active MCP native gate (%s)",
	async (active) => {
		const root = mkdtempSync(join(tmpdir(), "pr1473-mcp-"));
		const liveService = new McpService();
		const candidateService = new McpService();
		const liveScope = new ProviderScope();
		const candidateScope = new ProviderScope();
		const candidateRuntime = createExtensionRuntime();
		const makeCwd = (name: string, enabled: boolean) => {
			const cwd = join(root, name);
			mkdirSync(join(cwd, ".senpi"), { recursive: true });
			writeFileSync(
				join(cwd, ".senpi", "mcp.json"),
				JSON.stringify({ settings: { nativeToolSearch: enabled }, mcpServers: {} }),
			);
			return cwd;
		};
		const liveCwd = makeCwd("live", active);
		const candidateCwd = makeCwd("candidate", !active);
		const attach = async (extension: Extension, cwd: string) => {
			for (const handler of extension.handlers.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "resume" }, { cwd, isProjectTrusted: () => true });
			}
		};
		try {
			await runWithProviderScope(liveScope, async () => {
				const live = await loadExtensionFromFactory(
					createMcpExtension(liveService),
					liveCwd,
					createEventBus(),
					createExtensionRuntime(),
					"<live-mcp>",
				);
				await attach(live, liveCwd);
				expect(liveService.getNativeToolSearchSetting()).toBe(active);
				expect(isMcpNativeToolSearchEnabled()).toBe(active);
				expect(independent.runInAsyncScope(isMcpNativeToolSearchEnabled)).toBe(active);
				await runWithProviderScope(candidateScope, async () => {
					await loadExtensionFromFactory(
						createMcpExtension(candidateService),
						candidateCwd,
						createEventBus(),
						candidateRuntime,
						"<discarded-mcp>",
					);
					expect(candidateService.getSnapshot().sessionStartCount).toBe(0);
					candidateRuntime.invalidate();
					expect.soft(isMcpNativeToolSearchEnabled()).toBe(active);
				});
				expect.soft(independent.runInAsyncScope(isMcpNativeToolSearchEnabled)).toBe(active);
				const accepted = await runWithProviderScope(candidateScope, () =>
					loadExtensionFromFactory(
						createMcpExtension(candidateService),
						candidateCwd,
						createEventBus(),
						createExtensionRuntime(),
						"<accepted-mcp>",
					),
				);
				await attach(accepted, candidateCwd);
				expect(candidateService.getNativeToolSearchSetting()).toBe(!active);
				expect(isMcpNativeToolSearchEnabled()).toBe(!active);
				expect(independent.runInAsyncScope(isMcpNativeToolSearchEnabled)).toBe(!active);
			});
		} finally {
			await Promise.all([liveService.dispose("quit"), candidateService.dispose("quit")]);
			liveScope.close();
			candidateScope.close();
			independent.runInAsyncScope(() => installMcpNativeToolSearchGate(() => false));
			rmSync(root, { recursive: true, force: true });
		}
	},
);
