import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Model as WireModel } from "../../src/modes/app-server/protocol/generated/v2/Model.ts";
import { STABLE_CLIENT_REQUEST_METHODS } from "../../src/modes/app-server/protocol/methods.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";
import { createHarness } from "./harness.ts";

type SentMessage = RpcEnvelope;
type CapabilityManifest = {
	readonly implemented: {
		readonly stable: readonly string[];
	};
};
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function request(id: string | number, method: string, params?: unknown) {
	return { kind: "request" as const, message: params === undefined ? { id, method } : { id, method, params } };
}

function createCoreWithConnection(options: {
	readonly modelRegistry: Awaited<ReturnType<typeof createHarness>>["session"]["modelRegistry"];
	readonly experimentalApi?: boolean;
	readonly codexHome?: string;
}): { readonly core: ServerCore; readonly sent: SentMessage[]; readonly id: string } {
	const core = new ServerCore({
		modelRegistry: options.modelRegistry,
		version: "2026.7.2",
		codexHome: options.codexHome ?? "/tmp/senpi-app-server-test",
	});
	const sent: SentMessage[] = [];
	const connection = core.addConnection({
		id: "conn-models",
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
			clientInfo: { name: "qa", title: "QA", version: "0.0.1" },
			capabilities: { experimentalApi, requestAttestation: false },
		}),
	);
}

function expectResult(response: SentMessage | undefined): unknown {
	expect(response).toEqual({ id: expect.anything(), result: expect.anything() });
	if (response !== undefined && "result" in response) {
		return response.result;
	}
	throw new Error("expected result response");
}

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	expect(Array.isArray(value)).toBe(false);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected record");
	}
}

function expectUuidV4(value: unknown): string {
	expect(typeof value).toBe("string");
	if (typeof value !== "string") {
		throw new Error("expected UUID v4 string");
	}
	expect(value).toMatch(UUID_V4_PATTERN);
	return value;
}

function expectModel(value: unknown): asserts value is WireModel {
	expectRecord(value);
	expect(Object.keys(value).sort()).toEqual(
		[
			"additionalSpeedTiers",
			"availabilityNux",
			"defaultReasoningEffort",
			"defaultServiceTier",
			"description",
			"displayName",
			"hidden",
			"id",
			"inputModalities",
			"isDefault",
			"model",
			"serviceTiers",
			"supportedReasoningEfforts",
			"supportsPersonality",
			"upgrade",
			"upgradeInfo",
		].sort(),
	);
}

async function readImplementedStableMethods(): Promise<ReadonlySet<string>> {
	const manifest = JSON.parse(
		await readFile(new URL("../qa/app-server/capability-manifest.json", import.meta.url), "utf8"),
	) as CapabilityManifest;
	return new Set(manifest.implemented.stable);
}

function withTwoSecondTimeout<T>(promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error("app-server stable method sweep exceeded 2s")), 2000);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	});
}

describe("app-server model methods", () => {
	it("returns non-empty generated-model-compatible catalog entries from configured runtime models", async () => {
		// Given: a faux provider with a runtime key in the same registry path the RPC mode uses.
		const harness = await createHarness({
			models: [{ id: "faux-visible", name: "Faux Visible", reasoning: true, input: ["text", "image"] }],
		});
		try {
			const { core, sent, id } = createCoreWithConnection({ modelRegistry: harness.session.modelRegistry });
			await initialize(core, id, true);

			// When: the app-server client asks for models.
			await core.receive(id, request(2, "model/list", { includeHidden: false }));

			// Then: the response is non-empty and each model carries the generated v2 required field set.
			const result = expectResult(sent[1]);
			expectRecord(result);
			expect(result.nextCursor).toBeNull();
			expect(Array.isArray(result.data)).toBe(true);
			const targetModel = Array.isArray(result.data)
				? result.data.find(
						(model) =>
							typeof model === "object" && model !== null && "id" in model && model.id === "faux/faux-visible",
					)
				: undefined;
			expectModel(targetModel);
			expect(targetModel).toMatchObject({
				id: "faux/faux-visible",
				model: "faux-visible",
				displayName: "Faux Visible",
				description: "",
				hidden: false,
				defaultReasoningEffort: "medium",
				inputModalities: ["text"],
				supportsPersonality: false,
				additionalSpeedTiers: [],
				serviceTiers: [],
				defaultServiceTier: null,
				isDefault: false,
				upgrade: null,
				upgradeInfo: null,
				availabilityNux: null,
			});
			expect(targetModel.supportedReasoningEfforts).toContainEqual({ reasoningEffort: "medium", description: "" });
		} finally {
			harness.cleanup();
		}
	});

	it("returns the persisted HEAD remote-control status shape", async () => {
		// Given: an initialized experimental client and an isolated agent directory.
		const harness = await createHarness();
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-remote-control-status-"));
		try {
			const experimental = createCoreWithConnection({
				modelRegistry: harness.session.modelRegistry,
				experimentalApi: true,
				codexHome: agentDir,
			});
			await initialize(experimental.core, experimental.id, true);

			// When: the client asks for status twice, then after an invalid persisted value and a missing file.
			await experimental.core.receive(experimental.id, request(2, "remoteControl/status/read"));
			const firstStatus = expectResult(experimental.sent[1]);
			expectRecord(firstStatus);
			const firstInstallationId = expectUuidV4(firstStatus.installationId);
			expect(firstStatus).toEqual({
				status: "disabled",
				serverName: "senpi app-server",
				installationId: firstInstallationId,
				environmentId: null,
			});
			const installationIdPath = join(agentDir, "app-server", "installation-id");
			expect(await readFile(installationIdPath, "utf8")).toBe(`${firstInstallationId}\n`);

			await experimental.core.receive(experimental.id, request(3, "remoteControl/status/read"));
			const persistedStatus = expectResult(experimental.sent[2]);
			expectRecord(persistedStatus);
			expect(persistedStatus.installationId).toBe(firstInstallationId);

			await writeFile(installationIdPath, "not-a-uuid\n", "utf8");
			await experimental.core.receive(experimental.id, request(4, "remoteControl/status/read"));
			const regeneratedStatus = expectResult(experimental.sent[3]);
			expectRecord(regeneratedStatus);
			const regeneratedInstallationId = expectUuidV4(regeneratedStatus.installationId);
			expect(regeneratedInstallationId).not.toBe(firstInstallationId);
			expect(await readFile(installationIdPath, "utf8")).toBe(`${regeneratedInstallationId}\n`);

			await rm(installationIdPath);
			await experimental.core.receive(experimental.id, request(5, "remoteControl/status/read"));
			const missingFileStatus = expectResult(experimental.sent[4]);
			expectRecord(missingFileStatus);
			const missingFileInstallationId = expectUuidV4(missingFileStatus.installationId);
			expect(missingFileInstallationId).not.toBe(regeneratedInstallationId);
			expect(await readFile(installationIdPath, "utf8")).toBe(`${missingFileInstallationId}\n`);
		} finally {
			harness.cleanup();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("reclaims an abandoned installation id lock before regenerating invalid status", async () => {
		// Given: an initialized experimental client with invalid status and a stale lock from a dead owner.
		const harness = await createHarness();
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-remote-control-stale-lock-"));
		try {
			const experimental = createCoreWithConnection({
				modelRegistry: harness.session.modelRegistry,
				experimentalApi: true,
				codexHome: agentDir,
			});
			await initialize(experimental.core, experimental.id, true);
			const installationIdPath = join(agentDir, "app-server", "installation-id");
			const lockPath = `${installationIdPath}.lock`;
			await mkdir(join(agentDir, "app-server"), { recursive: true });
			await writeFile(installationIdPath, "not-a-uuid\n", "utf8");
			await mkdir(lockPath);
			await writeFile(
				join(lockPath, "owner-dead-owner.json"),
				`${JSON.stringify({ ownerToken: "dead-owner", pid: 999_999_999, createdAtMs: 1 })}\n`,
				"utf8",
			);

			// When: status/read runs while only the abandoned lock blocks regeneration.
			await experimental.core.receive(experimental.id, request(2, "remoteControl/status/read"));

			// Then: the lock is self-reclaimed, a new UUID is returned and persisted, and no lock remains.
			const status = expectResult(experimental.sent[1]);
			expectRecord(status);
			const installationId = expectUuidV4(status.installationId);
			expect(await readFile(installationIdPath, "utf8")).toBe(`${installationId}\n`);
			await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			harness.cleanup();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("returns one persisted installation id to concurrent first readers", async () => {
		// Given: 32 initialized experimental connections on one core with one empty agent directory.
		const harness = await createHarness();
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-remote-control-race-"));
		try {
			const core = new ServerCore({
				modelRegistry: harness.session.modelRegistry,
				version: "2026.7.2",
				codexHome: agentDir,
			});
			const clients = Array.from({ length: 32 }, (_, index) => {
				const sent: SentMessage[] = [];
				const connection = core.addConnection({
					id: `conn-remote-control-${index}`,
					transportKind: "stdio",
					send: (message) => {
						sent.push(message);
					},
					close: () => undefined,
				});
				return { id: connection.id, sent };
			});
			await Promise.all(clients.map((client) => initialize(core, client.id, true)));

			// When: every connection performs its first status read concurrently.
			await Promise.all(
				clients.map((client, index) => core.receive(client.id, request(index + 2, "remoteControl/status/read"))),
			);

			// Then: every response contains the one UUID persisted for this agent directory.
			const installationIds = clients.map((client) => {
				const status = expectResult(client.sent[1]);
				expectRecord(status);
				return expectUuidV4(status.installationId);
			});
			const persistedInstallationId = (
				await readFile(join(agentDir, "app-server", "installation-id"), "utf8")
			).trim();
			expect(installationIds).toEqual(Array.from({ length: clients.length }, () => persistedInstallationId));
		} finally {
			harness.cleanup();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("gates both remote-control methods and returns an internal client-list error", async () => {
		// Given: initialized clients with and without the experimental capability.
		const harness = await createHarness();
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-remote-control-gate-"));
		try {
			const stable = createCoreWithConnection({
				modelRegistry: harness.session.modelRegistry,
				experimentalApi: false,
				codexHome: agentDir,
			});
			await initialize(stable.core, stable.id, false);
			const experimental = createCoreWithConnection({
				modelRegistry: harness.session.modelRegistry,
				experimentalApi: true,
				codexHome: agentDir,
			});
			await initialize(experimental.core, experimental.id, true);

			// When: both clients ask for status and the remote client list.
			await stable.core.receive(stable.id, request(2, "remoteControl/status/read"));
			await stable.core.receive(
				stable.id,
				request(3, "remoteControl/client/list", { environmentId: "environment" }),
			);
			await experimental.core.receive(experimental.id, request(2, "remoteControl/status/read"));
			await experimental.core.receive(
				experimental.id,
				request(3, "remoteControl/client/list", { environmentId: "environment" }),
			);

			// Then: both methods are gated, while experimental client/list uses Codex's internal no-handle error.
			expect(stable.sent[1]).toEqual({
				id: 2,
				error: { code: -32600, message: "remoteControl/status/read requires experimentalApi capability" },
			});
			expect(stable.sent[2]).toEqual({
				id: 3,
				error: { code: -32600, message: "remoteControl/client/list requires experimentalApi capability" },
			});
			expect(experimental.sent[1]).toMatchObject({ id: 2, result: { status: "disabled" } });
			expect(experimental.sent[2]).toEqual({
				id: 3,
				error: { code: -32603, message: "remote control is unavailable for this app-server" },
			});
		} finally {
			harness.cleanup();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("validates remote-control client-list parameters before the no-handle error", async () => {
		const harness = await createHarness();
		try {
			const experimental = createCoreWithConnection({
				modelRegistry: harness.session.modelRegistry,
				experimentalApi: true,
			});
			await initialize(experimental.core, experimental.id, true);
			const malformedParams: readonly unknown[] = [
				undefined,
				{},
				{ environmentId: 42 },
				{ environmentId: "environment", cursor: 42 },
				{ environmentId: "environment", order: "sideways" },
				{ environmentId: "environment", limit: -1 },
				{ environmentId: "environment", limit: 1.5 },
				{ environmentId: "environment", limit: 0x1_0000_0000 },
			];

			for (const [index, params] of malformedParams.entries()) {
				await experimental.core.receive(experimental.id, request(index + 2, "remoteControl/client/list", params));
			}
			await experimental.core.receive(
				experimental.id,
				request(20, "remoteControl/client/list", {
					environmentId: "environment",
					cursor: null,
					limit: 0xffff_ffff,
					order: "desc",
				}),
			);

			for (const [index] of malformedParams.entries()) {
				expect(experimental.sent[index + 1]).toMatchObject({ id: index + 2, error: { code: -32600 } });
			}
			expect(experimental.sent.at(-1)).toEqual({
				id: 20,
				error: { code: -32603, message: "remote control is unavailable for this app-server" },
			});
		} finally {
			harness.cleanup();
		}
	});

	it("uses the capability manifest for unimplemented stable methods and returns honest account errors", async () => {
		// Given: an initialized connection, the generated stable inventory, and the manifest-backed implementation set.
		const harness = await createHarness();
		try {
			const { core, sent, id } = createCoreWithConnection({ modelRegistry: harness.session.modelRegistry });
			await initialize(core, id, true);
			const implementedStableMethods = await readImplementedStableMethods();
			const honestAccountReads = ["account/rateLimits/read", "account/usage/read"] as const;
			for (const method of honestAccountReads) {
				expect(implementedStableMethods.has(method)).toBe(true);
			}
			const unimplementedStableMethods = STABLE_CLIENT_REQUEST_METHODS.filter(
				(method) => !implementedStableMethods.has(method),
			);
			const methodsToDispatch = [...unimplementedStableMethods, ...honestAccountReads];

			// When: every manifest-declared OUT method and both implemented, gated account reads are dispatched.
			await withTwoSecondTimeout(
				Promise.all(
					methodsToDispatch.map((method, index) => core.receive(id, request(index + 10, method, {}))),
				).then(() => undefined),
			);

			// Then: OUT methods are clean -32601 responses, while account reads return their honest gated error contract.
			const responses = sent.slice(1);
			expect(responses).toHaveLength(methodsToDispatch.length);
			for (const [index, method] of unimplementedStableMethods.entries()) {
				expect(responses[index]).toEqual({
					id: index + 10,
					error: { code: -32601, message: `Method not found: ${method}` },
				});
			}
			const accountRequestId = unimplementedStableMethods.length + 10;
			expect(responses.slice(unimplementedStableMethods.length)).toEqual([
				{
					id: accountRequestId,
					error: {
						code: -32600,
						message: "codex account authentication required to read rate limits",
					},
				},
				{
					id: accountRequestId + 1,
					error: {
						code: -32600,
						message: "codex account authentication required to read token usage",
					},
				},
			]);
		} finally {
			harness.cleanup();
		}
	});
});
