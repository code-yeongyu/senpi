import { describe, expect, it } from "vitest";
import { createIdMapper } from "../../src/core/extensions/builtin/pi-codex-app-server/id-mapper.ts";
import { createRequestRouter } from "../../src/core/extensions/builtin/pi-codex-app-server/request-router.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";
import { RecordingAppServerClient } from "./pi-codex-app-server-routing-fakes.ts";

describe("pi-codex-app-server session read routing", () => {
	it("routes session read with the bound app-server thread id", async () => {
		const registry = createSessionRegistry();
		const client = new RecordingAppServerClient([
			{ thread: { id: "app-thread-1", session_id: "app-session-1" } },
			{ thread: { id: "app-thread-1", session_id: "app-session-1", name: "read thread" } },
		]);
		const router = createRequestRouter({
			client,
			idMapper: createIdMapper(),
			sessionRegistry: registry,
		});

		await router.route({
			method: "session/new",
			externalRequestId: "external-request-read-start",
			params: { externalSessionId: "external-session-1", appParams: { cwd: "/tmp/project" } },
		});
		const read = await router.route({
			method: "session/read",
			externalRequestId: "external-request-read",
			params: { externalSessionId: "external-session-1" },
		});

		expect(read).toMatchObject({
			kind: "app-server-response",
			appServerResponse: { thread: { id: "app-thread-1", name: "read thread" } },
		});
		expect(client.calls).toEqual([
			{ method: "thread/start", params: { cwd: "/tmp/project" } },
			{ method: "thread/read", params: { thread_id: "app-thread-1" } },
		]);
	});

	it("rejects unknown and tombstoned session reads before calling app-server", async () => {
		const registry = createSessionRegistry();
		const client = new RecordingAppServerClient([
			{ thread: { id: "app-thread-1", session_id: "app-session-1" } },
			{ ok: true },
		]);
		const router = createRequestRouter({
			client,
			idMapper: createIdMapper(),
			sessionRegistry: registry,
		});

		const unknown = await router.route({
			method: "session/read",
			externalRequestId: "external-request-read-unknown",
			params: { externalSessionId: "missing-session" },
		});
		await router.route({
			method: "session/new",
			externalRequestId: "external-request-read-start-2",
			params: { externalSessionId: "external-session-1", appParams: { cwd: "/tmp/project" } },
		});
		await router.route({
			method: "session/archive",
			externalRequestId: "external-request-read-archive",
			params: { externalSessionId: "external-session-1" },
		});
		const tombstoned = await router.route({
			method: "session/read",
			externalRequestId: "external-request-read-tombstoned",
			params: { externalSessionId: "external-session-1" },
		});

		expect(unknown).toMatchObject({
			kind: "adapter-error",
			error: { data: { source: "pi-codex-app-server", adapterCode: "invalid-session-state" } },
		});
		expect(tombstoned).toMatchObject({
			kind: "adapter-error",
			error: { data: { source: "pi-codex-app-server", adapterCode: "invalid-session-state" } },
		});
		expect(client.calls).toEqual([
			{ method: "thread/start", params: { cwd: "/tmp/project" } },
			{ method: "thread/archive", params: { thread_id: "app-thread-1" } },
		]);
	});
});
