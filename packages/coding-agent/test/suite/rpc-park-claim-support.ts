import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { CreateAgentSessionRuntimeResult } from "../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { createRpcSessionBinding } from "../../src/modes/rpc/session-binding.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "./harness.ts";

/** The production router, binding, writer and registry; only model execution uses the faux provider. */
export async function parkClaimHost() {
	const cwd = await mkdtemp(join(tmpdir(), "rpc-park-claim-"));
	const harnesses: Harness[] = [];
	const closed = new Map<string, PromiseWithResolvers<void>>();
	const records: Record<string, unknown>[] = [];
	const sizes: number[] = [];
	const shutdowns = new Map<string, () => void>();
	const exited = Promise.withResolvers<void>();
	let buildGate: PromiseWithResolvers<void> | undefined;
	let builds = 0;
	const registry = new RpcSessionRegistry({
		agentDir: cwd,
		onSizeChange: (size) => sizes.push(size),
		createRuntime: async (options) => {
			builds++;
			await buildGate?.promise;
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			const h = await createHarness({
				cwd: options.cwd,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				models: [
					{ id: "first", reasoning: true },
					{ id: "second", reasoning: true },
				],
			});
			harnesses.push(h);
			const end = Promise.withResolvers<void>();
			closed.set(h.session.sessionId, end);
			const dispose = h.session.dispose.bind(h.session);
			vi.spyOn(h.session, "dispose").mockImplementation(() => {
				dispose();
				end.resolve();
			});
			return {
				session: h.session,
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
	for (const id of ["owner", "observer"])
		writer.registerConnection(id, {
			writeRaw: (line) => records.push({ ...JSON.parse(line), connection: id }),
			waitForBackpressure: async () => {},
		});
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd, hostContext: { host_instance: "park-host" } },
		async (...args) => {
			shutdowns.set(args[0], args[3]);
			return createRpcSessionBinding(...args);
		},
		{},
		{ handoverParkedDir: cwd, onEmptyExit: () => exited.resolve() },
	);
	let next = 0;
	return {
		cwd,
		registry,
		router,
		writer,
		records,
		sizes,
		shutdownPark: (sessionId: string) => shutdowns.get(sessionId)?.(),
		harnesses,
		exited: exited.promise,
		get builds() {
			return builds;
		},
		holdBuilds() {
			buildGate = Promise.withResolvers<void>();
		},
		releaseBuilds() {
			buildGate?.resolve();
			buildGate = undefined;
		},
		closed: (durableId: string) => closed.get(durableId)?.promise,
		async request(command: RpcCommand, connection = "owner"): Promise<RpcResponse> {
			const id = `request-${++next}`;
			const response = await writer.withConnection(connection, () => router.handle({ ...command, id }));
			await writer.flush();
			const result = response ?? records.findLast((record) => record.type === "response" && record.id === id);
			if (!result) throw new Error(`No reply for ${command.type}`);
			return result as RpcResponse;
		},
		async [Symbol.asyncDispose]() {
			buildGate?.resolve();
			await router.dispose();
			for (const h of harnesses.reverse()) h.cleanup();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}
