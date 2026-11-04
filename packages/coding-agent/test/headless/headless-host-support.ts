import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { HostIdleOverrides } from "../../src/modes/rpc/host-idle-policy.ts";
import { headlessHostOptions } from "../../src/modes/headless/headless-host.ts";
import { createHostCore, type MultiSessionHostOptions } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

export type HostKind = "headless" | "client-owned";

export interface ResponseRecord {
	readonly type: "response";
	readonly id?: string;
	readonly success: boolean;
	readonly error?: string;
	readonly data?: unknown;
}

export interface SessionRow {
	readonly sessionId: string;
	readonly status: string;
	readonly attachments: number;
	readonly retain_on_disconnect?: boolean;
}

/** A host core on a temp agent dir whose sessions offer `/owned-turn`: it starts, waits for `release`, then appends an entry. */
export interface HostRig {
	readonly root: string;
	readonly core: ReturnType<typeof createHostCore>;
	readonly writer: SessionEventWriter;
	readonly turnStarted: Promise<void>;
	newSessionFile(): Promise<string>;
	connect(connection: string): void;
	/** Every record delivered to `connection`, in order. */
	recordsFor(connection: string): readonly Record<string, unknown>[];
	send(connection: string, command: Record<string, unknown>): Promise<void>;
	response(id: string): Promise<ResponseRecord>;
	openSession(connection: string, sessionPath: string): Promise<string>;
	listSessions(connection: string): Promise<readonly SessionRow[]>;
	detach(connection: string): Promise<void>;
	releaseTurn(): void;
	dispose(): Promise<void>;
}

export const OWNED_TURN_ENTRY = "owned-turn-finished";

export async function startHostRig(
	kind: HostKind,
	idle: HostIdleOverrides = {},
	host: Pick<MultiSessionHostOptions, "sessionTakeover"> = {},
): Promise<HostRig> {
	const root = await mkdtemp(join(tmpdir(), "headless-host-"));
	const records: unknown[] = [];
	const byConnection = new Map<string, Record<string, unknown>[]>();
	const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: root,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.registerCommand("owned-turn", {
							handler: async () => {
								started.resolve();
								await release.promise;
								pi.appendEntry(OWNED_TURN_ENTRY, { complete: true });
							},
						});
					},
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const base: MultiSessionHostOptions = { ...host, agentDir: root, cwd: root, createRuntime, listen: "stdio://" };
	const core = createHostCore(kind === "headless" ? headlessHostOptions(base) : base, writer, [], {
		closeGraceMs: 100,
		...idle,
	});
	const send = (connection: string, command: Record<string, unknown>) =>
		writer.withConnection(connection, () => core.handle(JSON.stringify(command)));
	const response = async (id: string): Promise<ResponseRecord> => {
		await writer.flush();
		const found = records.find(
			(record): record is ResponseRecord =>
				typeof record === "object" &&
				record !== null &&
				Reflect.get(record, "type") === "response" &&
				Reflect.get(record, "id") === id,
		);
		if (found === undefined) throw new Error(`no response for ${id}`);
		return found;
	};
	return {
		root,
		core,
		writer,
		turnStarted: started.promise,
		newSessionFile: async () => {
			const file = join(root, `${randomUUID()}.jsonl`);
			const header = {
				type: "session",
				version: 3,
				id: randomUUID(),
				cwd: root,
				timestamp: new Date(0).toISOString(),
			};
			await writeFile(file, `${JSON.stringify(header)}\n`);
			return file;
		},
		connect: (connection) => {
			const own: Record<string, unknown>[] = [];
			byConnection.set(connection, own);
			writer.registerConnection(connection, {
				writeRaw: (line) => {
					const record = JSON.parse(line);
					records.push(record);
					own.push(record);
				},
				waitForBackpressure: () => Promise.resolve(),
			});
		},
		recordsFor: (connection) => byConnection.get(connection) ?? [],
		send,
		response,
		openSession: async (connection, sessionPath) => {
			const id = `open-${randomUUID()}`;
			await send(connection, { type: "open_session", id, cwd: root, sessionPath });
			const opened = await response(id);
			const sessionId = Reflect.get(Object(opened.data), "sessionId");
			if (!opened.success || typeof sessionId !== "string") throw new Error(`open failed: ${opened.error}`);
			return sessionId;
		},
		listSessions: async (connection) => {
			const id = `list-${randomUUID()}`;
			await send(connection, { type: "list_sessions", id });
			const listed = await response(id);
			const sessions: unknown = Reflect.get(Object(listed.data), "sessions");
			if (!Array.isArray(sessions)) throw new Error("list_sessions returned no rows");
			return sessions;
		},
		detach: async (connection) => {
			writer.unregisterConnection(connection);
			await core.router.releaseConnection(connection);
		},
		releaseTurn: () => release.resolve(),
		dispose: async () => {
			release.resolve();
			await core.router.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}
