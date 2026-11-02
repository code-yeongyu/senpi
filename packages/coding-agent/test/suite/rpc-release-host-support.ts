/**
 * A real in-process host for the release suites: the production router, registry, writer and session
 * binding over REAL `AgentSession`s (faux provider, real extension runner, real admission ledger and
 * queues), so an extension's drain, the agent-level queue and the teardown window all run the code
 * the daemon runs. Sessions are opened retained and then detached, as `omo daemon adopt` finds them.
 */
import type { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string };

export interface OpenedSession {
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly session: AgentSession;
}

export const heldTurn: FauxResponseStep = (_context, options) =>
	new Promise((resolve) => {
		const settle = (): void => resolve(fauxAssistantMessage("held turn ended"));
		if (options?.signal?.aborted) settle();
		else options?.signal?.addEventListener("abort", settle, { once: true });
	});

export interface ReleaseHostOptions {
	/** Advertised by the connection that opens each session, as a desktop's `set_client_info` would. */
	readonly capabilities?: readonly string[];
	/** Every record, with the connection whose socket received it (`undefined`: the host's default output). */
	readonly onRecord?: (record: WireRecord, connection: string | undefined) => void;
}

export async function startReleaseHost(extension: ExtensionFactory, options: ReleaseHostOptions = {}) {
	const dir = await mkdtemp(join(tmpdir(), "senpi-release-host-"));
	const cwd = join(dir, "cwd");
	await mkdir(cwd);
	// As for a daemon, the agent dir holds nothing the test writes: its config-reload watcher reloads a
	// session on a JSON change there.
	const agentDir = join(dir, "agent");
	await mkdir(agentDir);
	// A NATIVE faux provider registered from each session's own extension load: every session runs in its
	// own `ProviderScope`, and a scoped lookup sees that scope's overlay and the builtins only.
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	const model = faux.getModel();
	const registerFaux: ExtensionFactory = (pi) => {
		pi.registerProvider(faux.provider);
	};
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: join(dir, "models.json"),
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: sessionCwd,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			agentDir,
			cwd: sessionCwd,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [registerFaux, extension],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const registry = new RpcSessionRegistry({ agentDir, createRuntime, closeGraceMs: 2_000 });
	const records: WireRecord[] = [];
	const answerWaiters = new Map<string, (record: WireRecord) => void>();
	const receive = (line: string, connection?: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		options.onRecord?.(record, connection);
		if (record.type === "response" && typeof record.id === "string") answerWaiters.get(record.id)?.(record);
	};
	const writer = new SessionEventWriter(receive);
	// Session-scoped commands need no attachment: this connection sends them, like a gateway client.
	const sink = (connection: string) => ({
		writeRaw: (line: string) => receive(line, connection),
		waitForBackpressure: async () => {},
	});
	writer.registerConnection("driver", sink("driver"));
	const router = new SessionCommandRouter(registry, writer, {
		cwd,
		hostContext: { host_socket: join(dir, "host.sock"), host_instance: "release-test-host" },
	});
	let serial = 0;

	const connections = new Set(["driver"]);
	// A connection's commands are handled in order: a command held in preflight holds back later ones on it.
	const send = async (command: RpcCommand & { id: string }, connection = "driver"): Promise<WireRecord> => {
		if (!connections.has(connection)) {
			connections.add(connection);
			writer.registerConnection(connection, sink(connection));
		}
		const answered = new Promise<WireRecord>((resolve) => answerWaiters.set(command.id, resolve));
		const direct = await writer.withConnection(connection, () => router.handle(command));
		await writer.flush();
		const answer = (direct as WireRecord | undefined) ?? (await answered);
		answerWaiters.delete(command.id);
		return answer;
	};

	return {
		faux,
		router,
		send,
		async open(name: string): Promise<OpenedSession> {
			const connection = `open-${name}`;
			writer.registerConnection(connection, sink(connection));
			if (options.capabilities !== undefined) {
				const capabilities = [...options.capabilities];
				await writer.withConnection(connection, () =>
					router.handle({ type: "set_client_info", id: `caps-${name}`, width: 80, capabilities }),
				);
			}
			const id = `open-${++serial}`;
			const sessionPath = join(dir, `${name}.jsonl`);
			await writer.withConnection(connection, () =>
				router.handle({ type: "open_session", id, cwd, sessionPath, retain_on_disconnect: true }),
			);
			await writer.flush();
			const reply = records.find((record) => record.id === id);
			const data = reply?.data as { sessionId?: string; state?: { sessionFile?: string } } | undefined;
			const sessionId = data?.sessionId;
			const session = sessionId === undefined ? undefined : registry.peek(sessionId)?.runtime?.session;
			if (sessionId === undefined || session === undefined) throw new Error(`open failed: ${JSON.stringify(reply)}`);
			// `agent_settled` ends every run, but reaches subscribers before its extension handlers finish (omo#11419),
			// so the seed prompt call can still be open then: wait for it to return, as a release would count it busy.
			const settled = nextEvent(session, "agent_settled");
			await send({ type: "prompt", id: `seed-${serial}`, sessionId, message: "seed the transcript" });
			await settled;
			const bindings = (Reflect.get(router, "context") as RouterContext).bindings;
			const pending = () => bindings.get(sessionId)?.pendingPrompts?.() ?? [];
			for (let calls = pending(); calls.length > 0; calls = pending()) await Promise.allSettled(calls);
			writer.unregisterConnection(connection);
			await router.releaseConnection(connection);
			return { sessionId, sessionPath: data?.state?.sessionFile ?? sessionPath, session };
		},
		/** Attaches `connection` (a fresh one by default); `send(command, connection)` then speaks as that client. */
		async attach(
			sessionPath: string,
			connection = `attach-${serial + 1}`,
			capabilities?: readonly string[],
		): Promise<WireRecord> {
			++serial;
			if (!connections.has(connection)) {
				connections.add(connection);
				writer.registerConnection(connection, sink(connection));
			}
			if (capabilities !== undefined)
				await writer.withConnection(connection, () =>
					router.handle({
						type: "set_client_info",
						id: `caps-${connection}`,
						width: 80,
						capabilities: [...capabilities],
					}),
				);
			const id = `attach-${serial}`;
			const answered = new Promise<WireRecord>((resolve) => answerWaiters.set(id, resolve));
			await writer.withConnection(connection, () =>
				router.handle({ type: "open_session", id, cwd, sessionPath, retain_on_disconnect: true }),
			);
			await writer.flush();
			const answer = records.find((record) => record.id === id) ?? (await answered);
			answerWaiters.delete(id);
			return answer;
		},
		release(sessionId: string, fields: { interrupt?: boolean } = {}): Promise<WireRecord> {
			return send({ type: "release_session", id: `release-${++serial}`, sessionId, reason: "takeover", ...fields });
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export function nextEvent(session: AgentSession, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

export function afterReleased(sessionPath: string): string[] | null {
	const kinds = SessionManager.open(sessionPath)
		.getEntries()
		.map((entry) =>
			entry.type === "custom"
				? `custom:${entry.customType}`
				: entry.type === "custom_message"
					? `custom_message:${entry.customType}`
					: entry.type === "message"
						? `message:${entry.message.role}`
						: entry.type,
		);
	const index = kinds.indexOf(`custom:${SESSION_RELEASED_ENTRY_TYPE}`);
	return index === -1 ? null : kinds.slice(index + 1);
}
