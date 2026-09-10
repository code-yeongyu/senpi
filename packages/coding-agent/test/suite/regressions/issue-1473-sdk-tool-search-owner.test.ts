import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import {
	getToolSearchService,
	resetToolSearchServiceForTests,
} from "../../../src/core/extensions/builtin/tool-search/service.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";

async function createSdkFixture() {
	resetToolSearchServiceForTests();
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-sdk-owner-"));
	const faux = registerFauxProvider({
		api: "anthropic-messages",
		provider: "pr1473-sdk",
		models: [{ id: "primary" }, { id: "fallback" }],
	});
	const sessions: AgentSession[] = [];
	const started: string[] = [];
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "offline-fixture",
		baseUrl: faux.getModel().baseUrl,
		models: faux.models.map((model) => ({ ...model, compat: { supportsToolReferences: true } })),
	});
	return {
		faux,
		started,
		async createSession(name: string) {
			const extensionsResult = await createTestExtensionsResult(
				[
					{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
					(pi) => {
						pi.on("session_start", () => {
							started.push(name);
						});
						pi.registerTool({
							name,
							label: name,
							description: name,
							exposure: "search",
							parameters: Type.Object({ city: Type.String() }),
							execute: async (_id, params) => ({
								content: [{ type: "text", text: `${name}:${params.city}` }],
								details: { owner: name },
							}),
						});
					},
				],
				cwd,
			);
			const { session } = await createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				model: { ...faux.getModel(), compat: { supportsToolReferences: true } },
				modelRegistry,
				authStorage,
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: {
						enabled: true,
						fallbackChains: { "pr1473-sdk/primary": ["pr1473-sdk/fallback"] },
					},
				}),
				noTools: "builtin",
				autoTitleSessions: false,
			});
			sessions.push(session);
			return session;
		},
		async cleanup() {
			for (const session of sessions) await session.disposeCandidate();
			faux.unregister();
			resetToolSearchServiceForTests();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

// PR1473 PRRT_kwDORgY43c6g6BJn: documented SDK flow does not call bindExtensions/session_start.
it.each([false, true])("executes the SDK's deferred tool with unrelated global owner=%s", async (withLiveOwner) => {
	// Given an unbound SDK session, optionally beside an accepted live session.
	const fixture = await createSdkFixture();
	try {
		const live = withLiveOwner ? await fixture.createSession("live_hidden") : undefined;
		await live?.bindExtensions({});
		const session = await fixture.createSession("sdk_hidden");
		const payloads: unknown[] = [];
		fixture.faux.setResponses([
			async (_context, options, _state, model) => {
				payloads.push(await options?.onPayload?.({ tools: [] }, model, { model, headers: {} }));
				return fauxAssistantMessage(fauxToolCall("sdk_hidden", { city: "Seoul" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		expect(session.getActiveToolNames()).not.toContain("sdk_hidden");

		// When the provider calls the schema injected by this session's captured hook.
		await session.prompt("call the deferred tool");

		// Then normal agent-core dispatch executes this session's registered tool.
		expect(payloads[0]).toMatchObject({
			tools: expect.arrayContaining([
				{ name: "sdk_hidden", description: "sdk_hidden", input_schema: expect.any(Object), defer_loading: true },
			]),
		});
		expect(session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ toolName: "sdk_hidden", isError: false, content: [{ type: "text", text: "sdk_hidden:Seoul" }] },
		]);
		expect(fixture.started).toEqual(withLiveOwner ? ["live_hidden"] : []);
		if (live) {
			expect(live.getActiveToolNames()).not.toContain("sdk_hidden");
			expect(
				getToolSearchService()
					.getCatalog()
					.map((doc) => doc.name),
			).toEqual(["live_hidden"]);
		} else {
			expect(() => getToolSearchService()).toThrow();
		}
	} finally {
		await fixture.cleanup();
	}
});

it("recovers the SDK's native 400 without consuming the live owner's diagnostic", async () => {
	// Given separate accepted-live and unbound-SDK native injection owners.
	const fixture = await createSdkFixture();
	try {
		const live = await fixture.createSession("live_hidden");
		await live.bindExtensions({});
		const liveService = getToolSearchService();
		liveService.noteNativeInjectionFailure("live-owner-sentinel");
		const session = await fixture.createSession("sdk_hidden");
		const payloads: unknown[] = [];
		fixture.faux.setResponses([
			async (_context, options, _state, model) => {
				payloads.push(await options?.onPayload?.({ tools: [] }, model, { model, headers: {} }));
				await options?.onResponse?.({ status: 400, headers: {} }, model);
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "invalid_request_error: rejected tool reference",
				});
			},
			async (_context, options, _state, model) => {
				payloads.push(await options?.onPayload?.({ tools: [] }, model, { model, headers: {} }));
				return fauxAssistantMessage("recovered");
			},
		]);

		// When this SDK request is rejected and retried.
		await session.prompt("recover native injection");

		// Then retry stays on the same model, disables only local injection, and preserves the live signal.
		expect(fixture.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary", "primary"]);
		expect(payloads[0]).toMatchObject({
			tools: expect.arrayContaining([expect.objectContaining({ name: "sdk_hidden", defer_loading: true })]),
		});
		expect(payloads[1]).toEqual({ tools: [] });
		expect(liveService.takeNativeInjectionFailure()).toBe("live-owner-sentinel");
	} finally {
		await fixture.cleanup();
	}
});
