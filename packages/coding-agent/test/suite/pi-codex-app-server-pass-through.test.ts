import { describe, expect, it } from "vitest";
import { createIdMapper } from "../../src/core/extensions/builtin/pi-codex-app-server/id-mapper.ts";
import { createNotificationProjector } from "../../src/core/extensions/builtin/pi-codex-app-server/notification-projector.ts";
import { PI_CODEX_APP_SERVER_PROTOCOL_VERSION } from "../../src/core/extensions/builtin/pi-codex-app-server/protocol-core.ts";
import { createRequestRouter } from "../../src/core/extensions/builtin/pi-codex-app-server/request-router.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";
import { RecordingAppServerClient } from "./pi-codex-app-server-routing-fakes.ts";

describe("pi-codex-app-server Wave 5 pass-through", () => {
	it("passes filesystem, realtime, app, plugin, config, marketplace, and remote-control requests through after trust negotiation", async () => {
		const client = new RecordingAppServerClient([
			{ ok: true },
			{ watch_id: "watch-1" },
			{ voices: [] },
			{ apps: [] },
			{ plugins: [] },
			{ config: {} },
			{ installed: true },
			{ enabled: true },
		]);
		const router = createRequestRouter({
			client,
			idMapper: createIdMapper(),
			sessionRegistry: createSessionRegistry(),
		});

		await router.route({
			method: "initialize",
			params: {
				protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
				capabilities: {
					semanticEvents: true,
					opaqueNotifications: true,
					opaqueCallbacks: true,
					filesystem: true,
					realtime: true,
					appPluginConfig: true,
				},
			},
		});

		const results = [
			await router.route({ method: "fs/watch", params: { appParams: { path: "/tmp/project/src" } } }),
			await router.route({ method: "thread/realtime/listVoices", params: { appParams: { locale: "en-US" } } }),
			await router.route({ method: "app/list", params: { appParams: { include_disabled: true } } }),
			await router.route({ method: "plugin/list", params: { appParams: { include_builtin: true } } }),
			await router.route({ method: "config/read", params: { appParams: { section: "app-server" } } }),
			await router.route({ method: "marketplace/add", params: { appParams: { plugin_id: "plugin-a" } } }),
			await router.route({ method: "remoteControl/enable", params: { appParams: { bind: "127.0.0.1" } } }),
		];

		expect(results).toMatchObject([
			{ kind: "app-server-response", appServerResponse: { watch_id: "watch-1" } },
			{ kind: "app-server-response", appServerResponse: { voices: [] } },
			{ kind: "app-server-response", appServerResponse: { apps: [] } },
			{ kind: "app-server-response", appServerResponse: { plugins: [] } },
			{ kind: "app-server-response", appServerResponse: { config: {} } },
			{ kind: "app-server-response", appServerResponse: { installed: true } },
			{ kind: "app-server-response", appServerResponse: { enabled: true } },
		]);
		expect(client.calls).toEqual([
			{ method: "initialize", params: { capabilities: { optOutNotificationMethods: [] } } },
			{ method: "fs/watch", params: { path: "/tmp/project/src" } },
			{ method: "thread/realtime/listVoices", params: { locale: "en-US" } },
			{ method: "app/list", params: { include_disabled: true } },
			{ method: "plugin/list", params: { include_builtin: true } },
			{ method: "config/read", params: { section: "app-server" } },
			{ method: "marketplace/add", params: { plugin_id: "plugin-a" } },
			{ method: "remoteControl/enable", params: { bind: "127.0.0.1" } },
		]);
	});

	it("rejects filesystem, realtime, and app/plugin/config pass-through without the matching trust capability", async () => {
		const client = new RecordingAppServerClient([{ ok: true }]);
		const router = createRequestRouter({
			client,
			idMapper: createIdMapper(),
			sessionRegistry: createSessionRegistry(),
		});

		await router.route({
			method: "initialize",
			params: {
				protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
				capabilities: {
					semanticEvents: true,
					opaqueNotifications: true,
					opaqueCallbacks: true,
				},
			},
		});

		const fs = await router.route({ method: "fs/watch", params: { appParams: { path: "/tmp/project" } } });
		const realtime = await router.route({ method: "thread/realtime/start", params: { appParams: {} } });
		const config = await router.route({ method: "config/read", params: { appParams: {} } });

		expect([fs, realtime, config]).toMatchObject([
			{ kind: "adapter-error", error: { data: { adapterCode: "incompatible-capabilities" } } },
			{ kind: "adapter-error", error: { data: { adapterCode: "incompatible-capabilities" } } },
			{ kind: "adapter-error", error: { data: { adapterCode: "incompatible-capabilities" } } },
		]);
		expect(client.calls).toEqual([
			{ method: "initialize", params: { capabilities: { optOutNotificationMethods: [] } } },
		]);
	});

	it("keeps out-of-scope inventory methods unsupported for PR-011", async () => {
		const client = new RecordingAppServerClient([{ ok: true }]);
		const router = createRequestRouter({
			client,
			idMapper: createIdMapper(),
			sessionRegistry: createSessionRegistry(),
		});

		await router.route({
			method: "initialize",
			params: {
				protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
				capabilities: {
					semanticEvents: true,
					opaqueNotifications: true,
					opaqueCallbacks: true,
					filesystem: true,
					realtime: true,
					appPluginConfig: true,
				},
			},
		});

		const command = await router.route({ method: "command/exec", params: { appParams: { command: "pwd" } } });
		const mcp = await router.route({
			method: "mcpServer/tool/call",
			params: { appParams: { server: "test", tool: "echo" } },
		});

		expect([command, mcp]).toMatchObject([
			{ kind: "adapter-error", error: { data: { adapterCode: "unsupported-routing-method" } } },
			{ kind: "adapter-error", error: { data: { adapterCode: "unsupported-routing-method" } } },
		]);
		expect(client.calls).toEqual([
			{ method: "initialize", params: { capabilities: { optOutNotificationMethods: [] } } },
		]);
	});

	it("relays filesystem, realtime, warning, deprecation, config, app, and remote-control notifications as opaque app-server events", () => {
		const sessionRegistry = createSessionRegistry();
		const bindResult = sessionRegistry.bindSession({
			externalSessionId: "external-session-1",
			appThreadId: "app-thread-1",
			appSessionId: "app-session-1",
		});
		expect(bindResult.kind).toBe("bound");
		const projector = createNotificationProjector({
			connectionId: "connection-1",
			capabilityFlags: ["opaque-notifications", "filesystem", "realtime", "app-plugin-config"],
			notificationOptOuts: [],
			idMapper: createIdMapper(),
			sessionRegistry,
		});

		const projections = [
			projector.project({ method: "fs/changed", params: { thread_id: "app-thread-1", path: "/tmp/project/a.ts" } }),
			projector.project({
				method: "thread/realtime/transcript/delta",
				params: { thread_id: "app-thread-1", turn_id: "app-turn-1", item_id: "app-item-1", delta: "hi" },
			}),
			projector.project({ method: "warning", params: { thread_id: "app-thread-1", message: "warning" } }),
			projector.project({
				method: "deprecationNotice",
				params: { thread_id: "app-thread-1", message: "deprecated" },
			}),
			projector.project({ method: "configWarning", params: { thread_id: "app-thread-1", key: "sandbox" } }),
			projector.project({ method: "app/list/updated", params: { thread_id: "app-thread-1" } }),
			projector.project({ method: "remoteControl/status/changed", params: { thread_id: "app-thread-1" } }),
		];

		expect(projections).toMatchObject([
			{ kind: "opaque", method: "appServer/event", envelope: { sequence: 1, originalMethod: "fs/changed" } },
			{
				kind: "opaque",
				method: "appServer/event",
				envelope: {
					sequence: 2,
					originalMethod: "thread/realtime/transcript/delta",
					appTurnId: "app-turn-1",
					appItemId: "app-item-1",
				},
			},
			{ kind: "opaque", method: "appServer/event", envelope: { sequence: 3, originalMethod: "warning" } },
			{ kind: "opaque", method: "appServer/event", envelope: { sequence: 4, originalMethod: "deprecationNotice" } },
			{ kind: "opaque", method: "appServer/event", envelope: { sequence: 5, originalMethod: "configWarning" } },
			{ kind: "opaque", method: "appServer/event", envelope: { sequence: 6, originalMethod: "app/list/updated" } },
			{
				kind: "opaque",
				method: "appServer/event",
				envelope: { sequence: 7, originalMethod: "remoteControl/status/changed" },
			},
		]);
	});
});
