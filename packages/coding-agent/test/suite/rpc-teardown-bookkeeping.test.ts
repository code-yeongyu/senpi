import { afterEach, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeResult } from "../../src/core/agent-session-runtime.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { createHarness } from "./harness.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

function size(owner: object, field: string): number {
	return (Reflect.get(owner, field) as { size: number }).size;
}

async function realHost(beforeRuntime?: () => Promise<void>) {
	const harness = await createHarness({ persistSession: true });
	const records: Array<Record<string, unknown>> = [];
	const registry = new RpcSessionRegistry({
		agentDir: harness.tempDir,
		createRuntime: async ({ cwd, agentDir }) => {
			await beforeRuntime?.();
			return {
				session: harness.session,
				diagnostics: [],
				services: { cwd, agentDir },
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
	const router = new SessionCommandRouter(registry, writer, { cwd: harness.tempDir });
	cleanups.push(async () => {
		await router.dispose();
		harness.cleanup();
	});
	const connections = new Set<string>();
	const send = (command: RpcCommand, connection?: string) => {
		if (connection === undefined) return router.handle(command);
		if (!connections.has(connection)) {
			writer.registerConnection(connection, {
				writeRaw: (line) => records.push(JSON.parse(line)),
				waitForBackpressure: async () => {},
			});
			connections.add(connection);
		}
		return writer.withConnection(connection, () => router.handle(command));
	};
	return {
		harness,
		records,
		registry,
		writer,
		router,
		send,
		async open(connection?: string, retained = false) {
			expect(
				await send(
					{ type: "open_session", id: "open", cwd: harness.tempDir, retain_on_disconnect: retained },
					connection,
				),
			).toBeUndefined();
			await writer.flush();
			const sessionId = records.findLast((record) => record.id === "open")?.sessionId;
			if (typeof sessionId !== "string") throw new Error("missing routing handle");
			return sessionId;
		},
	};
}

it("forgets closed handles after terminal records without retaining one seal per session", async () => {
	const harness = await createHarness();
	await using host = createInProcessRig(harness.tempDir);
	cleanups.push(async () => harness.cleanup());
	const writer = Reflect.get(host.router, "writer") as SessionEventWriter;
	for (let cycle = 0; cycle < 3; cycle++) {
		const opened = await host.open("owner", {});
		const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId;
		if (!sessionId) throw new Error("missing routing handle");
		await host.close("owner", sessionId);
		expect(host.registry.size).toBe(0);
		expect(
			host
				.recordsFor("owner")
				.filter((record) => record.sessionId === sessionId)
				.at(-1),
		).toMatchObject({ type: "response", command: "close_session", success: true });
		expect(size(writer, "sealedSessions")).toBe(0);
		expect(size(writer, "workerSessions")).toBe(0);
		expect(size(host.router, "widths")).toBe(0);
	}
});

it("silences an already-running command after its binding and provider scope close", async () => {
	const host = await realHost();
	const sessionId = await host.open();
	const entered = Promise.withResolvers<void>();
	const available = Promise.withResolvers<Awaited<ReturnType<typeof host.harness.session.cycleModel>>>();
	vi.spyOn(host.harness.session, "cycleModel").mockImplementation(() => {
		entered.resolve();
		return available.promise;
	});
	const pending = host.send({ type: "cycle_model", direction: "forward", id: "late", sessionId });
	try {
		await Promise.race([
			entered.promise,
			pending.then((reply) => {
				throw new Error(`command finished before entering: ${JSON.stringify(reply)}`);
			}),
		]);
		await host.send({ type: "close_session", id: "close", sessionId });
		expect(host.registry.size).toBe(0);
		// This also models the already-existing host-eviction forget path.
		host.writer.forgetSession(sessionId);
		available.resolve(undefined);
		expect(await pending).toBeUndefined();
		await host.writer.flush();
		expect(host.records.some((record) => record.id === "late")).toBe(false);
		expect(host.records.at(-1)).toMatchObject({ id: "close", success: true });
	} finally {
		available.resolve(undefined);
		await pending;
	}
});

it("drops capability and empty width maps while retaining a detached live session", async () => {
	const host = await realHost();
	await host.send({ type: "set_client_info", width: 80, capabilities: ["rendered_components"] }, "owner");
	const sessionId = await host.open("owner", true);
	await host.send({ type: "set_client_info", sessionId, width: 123, capabilities: ["rendered_components"] }, "owner");
	expect(size(host.router, "pendingCapabilities")).toBe(1);
	expect(size(host.router, "widths")).toBe(1);
	await host.router.releaseConnection("owner");
	expect(host.registry.peek(sessionId)).toMatchObject({ state: "open", attachments: 0 });
	expect(size(host.router, "pendingCapabilities")).toBe(0);
	expect(size(host.router, "widths")).toBe(0);
});

it("drops capabilities for connections that never opened a session", async () => {
	const host = await realHost();
	await host.send({ type: "set_client_info", width: 80, capabilities: ["rendered_components"] }, "probe");
	await host.router.releaseConnection("probe");
	expect(size(host.router, "pendingCapabilities")).toBe(0);
});

it("finishes a disconnected pending open without publishing a response after its teardown", async () => {
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const host = await realHost(async () => {
		entered.resolve();
		await proceed.promise;
	});
	await host.send({ type: "set_client_info", width: 80, capabilities: ["rendered_components"] }, "owner");
	const enqueue = vi.spyOn(host.writer, "enqueue");
	const opening = host.send({ type: "open_session", id: "orphan-open", cwd: host.harness.tempDir }, "owner");
	await entered.promise;
	host.writer.unregisterConnection("owner");
	const releasing = host.router.releaseConnection("owner");
	proceed.resolve();
	expect(await opening).toBeUndefined();
	await releasing;
	await host.writer.flush();
	expect(host.registry.size).toBe(0);
	expect(enqueue.mock.calls.some(([, record]) => Reflect.get(record, "id") === "orphan-open")).toBe(false);
	expect(size(host.router, "pendingCapabilities")).toBe(0);
	expect(size(host.router, "sessionsByConnection")).toBe(0);
	expect(size(host.writer, "sealedSessions")).toBe(0);
});
