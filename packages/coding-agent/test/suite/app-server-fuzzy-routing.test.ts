import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppServerRuntime } from "../../src/modes/app-server/index.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { registerFuzzyFileSearchMethods } from "../../src/modes/app-server/search/fuzzy-search-methods.ts";
import { FuzzyFileSearchService } from "../../src/modes/app-server/search/fuzzy-search-service.ts";
import { NotificationRouter } from "../../src/modes/app-server/server/notifications.ts";
import {
	deferredCollector,
	FuzzyFakeConnection,
	fixtureEntry,
	fixtureRanker,
	fuzzyRequest,
	initializedConnection,
} from "./app-server-fuzzy-test-support.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("app-server fuzzy file registration and routing", () => {
	it("keeps one-shot stable, gates session requests, and broadcasts session notifications ungated", async () => {
		// Given: stable and experimental initialized router connections.
		const stable = new FuzzyFakeConnection("stable", false);
		const experimental = new FuzzyFakeConnection("experimental", true);
		const router = new NotificationRouter({ connections: [stable, experimental] });
		const traversal = deferredCollector();
		const service = new FuzzyFileSearchService({
			broadcast: (notification) => router.broadcast(notification),
			collectEntries: traversal.collect,
			rankEntries: fixtureRanker,
		});
		const registry = createRegistry();
		registerFuzzyFileSearchMethods(registry, service);

		// When: stable one-shot/session calls are dispatched, then an experimental session completes.
		const stableSearch = await registry.dispatch(
			initializedConnection(false),
			fuzzyRequest(1, "fuzzyFileSearch", { query: "", roots: ["/fixture"], cancellationToken: null }),
		);
		const gated = await registry.dispatch(
			initializedConnection(false),
			fuzzyRequest(2, "fuzzyFileSearch/sessionStart", { sessionId: "gated", roots: ["/fixture"] }),
		);
		const started = await registry.dispatch(
			initializedConnection(true),
			fuzzyRequest(3, "fuzzyFileSearch/sessionStart", { sessionId: "live", roots: ["/fixture"] }),
		);
		await traversal.entered;
		await registry.dispatch(
			initializedConnection(true),
			fuzzyRequest(4, "fuzzyFileSearch/sessionUpdate", { sessionId: "live", query: "visible" }),
		);
		traversal.release([fixtureEntry("visible.txt")]);
		await stable.completed;

		// Then: the request gate is experimental but both initialized clients receive stable notifications.
		expect(stableSearch).toEqual({ id: 1, result: { files: [] } });
		expect(gated).toEqual({
			id: 2,
			error: { code: -32600, message: "fuzzyFileSearch/sessionStart requires experimentalApi capability" },
		});
		expect(started).toEqual({ id: 3, result: {} });
		expect(stable.received.map((notification) => notification.method)).toEqual([
			"fuzzyFileSearch/sessionUpdated",
			"fuzzyFileSearch/sessionCompleted",
		]);
		expect(experimental.received.map((notification) => notification.method)).toEqual([
			"fuzzyFileSearch/sessionUpdated",
			"fuzzyFileSearch/sessionCompleted",
		]);
		service.dispose();
	});

	it("registers the stable method on the real runtime and returns a real fixture-tree hit", async () => {
		// Given: a real runtime, isolated fixture root, and initialized stable connection.
		const root = await scratch("runtime");
		await writeFile(join(root, "visible.txt"), "visible");
		const runtime = createAppServerRuntime(() => undefined);
		const sent: RpcEnvelope[] = [];
		const connection = runtime.core.addConnection({
			id: "runtime-stable",
			transportKind: "stdio",
			send: (message) => {
				sent.push(message);
			},
			close: () => undefined,
		});
		await runtime.core.receive(connection.id, initializeRequest(false));

		// When: the stable one-shot method searches the fixture root.
		await runtime.core.receive(connection.id, {
			kind: "request",
			message: fuzzyRequest(2, "fuzzyFileSearch", {
				query: "visible",
				roots: [root],
				cancellationToken: null,
			}),
		});

		// Then: the real runtime returns the relative path and matching indices.
		expect(sent[1]).toEqual({
			id: 2,
			result: {
				files: [
					expect.objectContaining({
						root,
						path: "visible.txt",
						match_type: "file",
						file_name: "visible.txt",
						indices: [0, 1, 2, 3, 4, 5, 6],
					}),
				],
			},
		});
		runtime.dispose();
	});
});

function initializeRequest(experimentalApi: boolean) {
	return {
		kind: "request" as const,
		message: fuzzyRequest(1, "initialize", {
			clientInfo: { name: "fuzzy-test", title: "Fuzzy Test", version: "0.0.1" },
			capabilities: { experimentalApi, requestAttestation: false },
		}),
	};
}

async function scratch(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-fuzzy-${label}-`));
	roots.push(root);
	return root;
}
