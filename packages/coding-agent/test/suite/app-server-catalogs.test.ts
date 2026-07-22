import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	CollaborationModeListResponse,
	ExperimentalFeatureListResponse,
	PermissionProfileListResponse,
} from "../../src/modes/app-server/protocol/index.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";
import { createHarness } from "./harness.ts";

type SentMessage = RpcEnvelope;
type ModelRegistry = Awaited<ReturnType<typeof createHarness>>["session"]["modelRegistry"];

describe("app-server catalog methods", () => {
	it("gates collaborationMode/list and preserves its literal snake_case preset member", async () => {
		// Given: a faux model catalog and one stable and one experimental connection.
		const harness = await createHarness({
			models: [{ id: "catalog-model", name: "Catalog Model", reasoning: true }],
		});
		try {
			const stable = createCore(harness.session.modelRegistry, "catalog-stable");
			await initialize(stable.core, stable.id, false);
			await stable.core.receive(stable.id, request(2, "collaborationMode/list", {}));
			expect(stable.sent[1]).toEqual({
				id: 2,
				error: { code: -32600, message: "collaborationMode/list requires experimentalApi capability" },
			});

			const experimental = createCore(harness.session.modelRegistry, "catalog-experimental");
			await initialize(experimental.core, experimental.id, true);

			// When: the experimental client requests the collaboration presets.
			await experimental.core.receive(experimental.id, request(2, "collaborationMode/list", {}));

			// Then: the response is the single pinned preset with the literal wire key.
			const result = resultOf(experimental.sent[1]);
			const expected: CollaborationModeListResponse = {
				data: [{ name: "default", mode: null, model: "catalog-model", reasoning_effort: null }],
			};
			expect(result).toEqual(expected);
			expect(JSON.stringify(result)).toContain('"reasoning_effort":null');
			expect(JSON.stringify(result)).not.toContain("reasoningEffort");
		} finally {
			harness.cleanup();
		}
	});

	it("clamps permission profiles and resolves a supplied cwd before deriving the pinned record", async () => {
		// Given: an isolated server cwd and a model registry.
		const root = await mkdtemp(join(tmpdir(), "senpi-app-server-catalogs-"));
		const harness = await createHarness({
			models: [{ id: "catalog-model", name: "Catalog Model", reasoning: true }],
		});
		try {
			const current = createCore(harness.session.modelRegistry, "catalog-permissions", root);
			await initialize(current.core, current.id, false);

			// When: the client requests the profile catalog with a relative cwd and a below-minimum limit.
			await current.core.receive(
				current.id,
				request(2, "permissionProfile/list", { cwd: ".", cursor: null, limit: 0 }),
			);

			// Then: cwd resolution does not change the exact single profile contract, and limit clamps to one.
			const first = resultOf(current.sent[1]);
			const expected: PermissionProfileListResponse = {
				data: [{ id: "dangerFullAccess", description: null, allowed: true }],
				nextCursor: null,
			};
			expect(first).toEqual(expected);

			await current.core.receive(
				current.id,
				request(3, "permissionProfile/list", { cwd: resolve(root), cursor: "1" }),
			);
			expect(resultOf(current.sent[2])).toEqual({
				data: [],
				nextCursor: null,
			} satisfies PermissionProfileListResponse);

			await current.core.receive(current.id, request(4, "permissionProfile/list", { cursor: "not-numeric" }));
			expect(current.sent[3]).toEqual({
				id: 4,
				error: { code: -32600, message: expect.stringContaining("permissionProfile/list") },
			});
		} finally {
			harness.cleanup();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("paginates the feature catalog and rejects an unknown loaded-thread selector", async () => {
		// Given: a stable app-server connection.
		const harness = await createHarness();
		try {
			const current = createCore(harness.session.modelRegistry, "catalog-features");
			await initialize(current.core, current.id, false);

			// When: the client requests the empty-or-static feature page at the clamp boundary.
			await current.core.receive(current.id, request(2, "experimentalFeature/list", { cursor: null, limit: 0 }));

			// Then: the stable response is paginated even when Senpi has no exposed feature records.
			const first = resultOf(current.sent[1]);
			expect(first).toEqual({ data: [], nextCursor: null } satisfies ExperimentalFeatureListResponse);

			await current.core.receive(
				current.id,
				request(3, "experimentalFeature/list", { threadId: "missing-loaded-thread", limit: 1 }),
			);
			expect(current.sent[2]).toEqual({
				id: 3,
				error: { code: -32600, message: expect.stringContaining("experimentalFeature/list") },
			});
		} finally {
			harness.cleanup();
		}
	});
});

function createCore(
	modelRegistry: ModelRegistry,
	id: string,
	serverCwd = "/tmp/senpi-app-server-catalogs",
): {
	readonly core: ServerCore;
	readonly sent: SentMessage[];
	readonly id: string;
} {
	const core = new ServerCore({
		modelRegistry,
		codexHome: "/tmp/senpi-app-server-catalogs-home",
		serverCwd,
		version: "2026.7.2",
	});
	const sent: SentMessage[] = [];
	const connection = core.addConnection({
		id,
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});
	return { core, sent, id: connection.id };
}

async function initialize(core: ServerCore, id: string, experimentalApi: boolean): Promise<void> {
	await core.receive(
		id,
		request(1, "initialize", {
			clientInfo: { name: "catalog-test", title: "Catalog Test", version: "0.0.1" },
			capabilities: { experimentalApi, requestAttestation: false },
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

function resultOf(message: SentMessage | undefined): unknown {
	expect(message).toEqual({ id: expect.anything(), result: expect.anything() });
	if (message !== undefined && "result" in message) return message.result;
	throw new Error("expected successful app-server response");
}
