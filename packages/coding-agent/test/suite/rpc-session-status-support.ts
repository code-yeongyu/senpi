/**
 * One multi-session host core built from the production seam (`createHostCore`: the in-process registry a
 * `--listen` host selects, the real router, gate, writer and fanout, real runtimes on a faux provider),
 * driven by raw JSONL clients. Each client is a registered connection whose requests enter as text lines
 * through the host's own parser and whose inbox is every line its socket would have received.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

export type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

export interface RawClient {
	readonly name: string;
	readonly inbox: readonly WireRecord[];
	request(command: Record<string, unknown>): Promise<WireRecord>;
	waitFor(predicate: (record: WireRecord) => boolean, ms?: number): Promise<WireRecord>;
}

const DEADLINE_MS = 30_000;

export async function statusHost() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-session-status-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const faux = fauxProvider({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
	const model = faux.getModel();
	/** Each session's extension API, by durable session id: how a test reaches a session's own event bus. */
	const extensionApis = new Map<string, ExtensionAPI>();
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
	]);
	const createRuntime = createCliRuntimeFactory(
		{ parsed, cwd, agentDir, appMode: "rpc" },
		{
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider);
					pi.on("session_start", (_event, ctx) => {
						extensionApis.set(ctx.sessionManager.getSessionId(), pi);
					});
				},
			],
		},
	);
	const clock = { now: 1_000_000 };
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore({ agentDir, createRuntime, cwd }, writer, [], {
		now: () => clock.now,
		idleEvictionMs: 1e12,
		emptyExitMs: 1e12,
		closeGraceMs: 1_000,
	});
	const listeners = new Set<(record: WireRecord) => void>();
	const clients: RawClient[] = [];
	let serial = 0;

	const client = (name: string): RawClient => {
		const inbox: WireRecord[] = [];
		writer.registerConnection(name, {
			writeRaw: (line) => {
				for (const text of line.split("\n")) {
					if (text === "") continue;
					const record = JSON.parse(text) as WireRecord;
					inbox.push(record);
					for (const listener of [...listeners]) listener(record);
				}
			},
			waitForBackpressure: async () => {},
		});
		const waitFor = (predicate: (record: WireRecord) => boolean, ms = DEADLINE_MS): Promise<WireRecord> => {
			const seen = inbox.find(predicate);
			if (seen) return Promise.resolve(seen);
			return new Promise((resolve, reject) => {
				const listener = (record: WireRecord): void => {
					if (!inbox.includes(record) || !predicate(record)) return;
					clearTimeout(timer);
					listeners.delete(listener);
					resolve(record);
				};
				const timer = setTimeout(() => {
					listeners.delete(listener);
					reject(
						new Error(`${name}: deadline waiting for ${String(predicate).replace(/\s+/g, " ").slice(0, 160)}`),
					);
				}, ms);
				listeners.add(listener);
			});
		};
		const created: RawClient = {
			name,
			inbox,
			waitFor,
			async request(command) {
				const id = `${name}-${++serial}`;
				const answered = waitFor((record) => record.type === "response" && record.id === id);
				await writer.withConnection(name, () => core.handle(JSON.stringify({ ...command, id })));
				return answered;
			},
		};
		clients.push(created);
		return created;
	};

	return {
		cwd,
		agentDir,
		clock,
		faux,
		model,
		writer,
		core,
		extensionApis,
		client,
		/** Drops a client the way the socket host does: unregister the transport, then release its sessions. */
		async drop(name: string): Promise<void> {
			writer.unregisterConnection(name);
			await core.router.releaseConnection(name);
		},
		async [Symbol.asyncDispose]() {
			await core.router.dispose();
			await writer.flush();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}

export function dataOf(record: WireRecord): Record<string, unknown> {
	if (record.success !== true) throw new Error(`request failed: ${String(record.error)}`);
	return (record.data as Record<string, unknown> | undefined) ?? {};
}

export function statusRecords(client: RawClient, subscriptionId: string): WireRecord[] {
	return client.inbox.filter((record) => record.type === "session_status" && record.subscriptionId === subscriptionId);
}
