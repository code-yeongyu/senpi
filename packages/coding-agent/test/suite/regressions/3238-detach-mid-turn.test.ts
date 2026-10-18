import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import type { RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

type SessionEvent = { readonly type: string };

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runtimeWithTurnRunningUntilSettled(
	listeners: Set<(event: SessionEvent) => void>,
	onDispose: () => void,
): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		new ProjectTrustStore(options.agentDir).set(options.cwd, true);
		return {
			session: {
				...fakeSessionBase(options),
				isFastModeActive: () => false,
				agent: { state: {} },
				isStreaming: true,
				getContextUsage: () => undefined,
				favoriteModels: [],
				scopedModels: [],
				isBashRunning: false,
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				subscribe: (listener: (event: SessionEvent) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				abort: async () => {},
				waitForIdle: async () => {},
				dispose: onDispose,
				messages: [],
				pendingMessageCount: 0,
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
}

async function hostWithRunningTurn() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3238-turn-"));
	directories.push(dir);
	const listeners = new Set<(event: SessionEvent) => void>();
	const disposeWaiters: Array<() => void> = [];
	const disposed = () => {
		for (const notify of disposeWaiters.splice(0)) notify();
	};
	const registry = new RpcSessionRegistry({
		agentDir: dir,
		createRuntime: runtimeWithTurnRunningUntilSettled(listeners, disposed),
	});
	const writer = new SessionEventWriter(() => {});
	for (const id of ["opener", "ref-client"])
		writer.registerConnection(id, { writeRaw: () => {}, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd: dir }, async () => ({
		handle: async () => {},
		dispose: async () => {},
	}));
	const path = join(dir, "turn.jsonl");
	const as = (connection: string, command: Parameters<SessionCommandRouter["handle"]>[0]) =>
		writer.withConnection(connection, () => router.handle(command)) as Promise<RpcResponse | undefined>;
	const settle = () => {
		for (const listener of [...listeners]) listener({ type: "agent_settled" });
	};
	const nextDispose = () => new Promise<void>((resolve) => disposeWaiters.push(resolve));
	return { registry, path, dir, as, settle, nextDispose };
}

const attachments = (registry: RpcSessionRegistry) => registry.list().map((row) => row.attachments);

describe("detach_connection on a session whose turn is still running (senpi#3238 review)", () => {
	it("#given another client also holds the session #when a client detaches mid-turn #then its attachment is gone when the answer arrives", async () => {
		// given
		const { registry, path, dir, as } = await hostWithRunningTurn();
		await as("opener", { type: "open_session", cwd: dir, sessionPath: path });
		await as("ref-client", { type: "open_session", cwd: dir, sessionPath: path });
		expect(attachments(registry)).toEqual([2]);

		// when
		const answer = await as("ref-client", { type: "detach_connection" });

		// then
		expect(attachments(registry)).toEqual([1]);
		expect(answer).toMatchObject({ success: true, data: { deferred: [] } });
	});

	it("#given the detaching client is the last holder #when it detaches mid-turn #then the answer names the session, the turn keeps running and the release lands when it settles", async () => {
		// given
		const { registry, path, dir, as, settle, nextDispose } = await hostWithRunningTurn();
		await as("ref-client", { type: "open_session", cwd: dir, sessionPath: path });
		const sessionId = registry.list()[0]?.sessionId;

		// when
		const answer = await as("ref-client", { type: "detach_connection" });

		// then
		expect(answer).toMatchObject({ success: true, data: { deferred: [sessionId] } });
		expect(attachments(registry)).toEqual([1]);
		const released = nextDispose();
		settle();
		await released;
		expect(registry.list().filter((row) => row.attachments > 0)).toEqual([]);
	});
});
