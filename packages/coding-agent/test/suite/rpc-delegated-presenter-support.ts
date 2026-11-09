/**
 * An in-process host core (`createHostCore`, MCP presenter enforcement on) with connections registered the way the
 * socket host registers them, so a test drives the real per-line dispatch and reads exactly what each connection
 * was written. Shared by the senpi#4249 R-1b (d) suites.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchProofSource } from "../../src/modes/rpc/delegated-connection.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

export type WireRecord = Record<string, unknown>;

export interface CorePeer {
	readonly id: string;
	readonly lines: WireRecord[];
	/** Hands one line to the host core under this connection and waits for its dispatch (not for the queue). */
	send(record: WireRecord): Promise<void>;
	written(predicate: (record: WireRecord) => boolean): Promise<WireRecord>;
	answers(id: string): WireRecord[];
}

export interface PeerOptions {
	readonly launchProof?: LaunchProofSource;
	/** The transport's drain; a never-settling promise stalls the connection's event queue after its next write. */
	readonly drain?: () => Promise<void>;
}

export async function startCore() {
	const root = await mkdtemp(join(tmpdir(), "x4249-"));
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir: root,
			cwd: root,
			createRuntime: async () => {
				throw new Error("this suite opens no session");
			},
			mcpPresenterEnforcement: true,
		},
		writer,
	);
	const peers: string[] = [];
	return {
		writer,
		peer(id: string, options: PeerOptions = {}): CorePeer {
			const lines: WireRecord[] = [];
			const watchers = new Set<(record: WireRecord) => void>();
			writer.registerConnection(
				id,
				{
					writeRaw: (line) => {
						const record = JSON.parse(line) as WireRecord;
						lines.push(record);
						for (const watch of watchers) watch(record);
					},
					waitForBackpressure: options.drain ?? (async () => {}),
				},
				options.launchProof === undefined ? {} : { launchProof: options.launchProof },
			);
			peers.push(id);
			return {
				id,
				lines,
				send: (record) => writer.withConnection(id, () => core.handle(JSON.stringify(record))),
				written: (predicate) => {
					const seen = lines.find(predicate);
					if (seen) return Promise.resolve(seen);
					return new Promise((resolve) => {
						const watch = (record: WireRecord) => {
							if (!predicate(record)) return;
							watchers.delete(watch);
							resolve(record);
						};
						watchers.add(watch);
					});
				},
				answers: (requestId) => lines.filter((record) => record.id === requestId),
			};
		},
		async dispose(): Promise<void> {
			for (const id of peers) writer.unregisterConnection(id);
			await core.router.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

export async function declare(peer: CorePeer, granted: readonly string[], id = "declare"): Promise<WireRecord> {
	const answered = peer.written((record) => record.id === id && record.command === "declare_delegation");
	await peer.send({ id, type: "declare_delegation", principal: { deviceId: "x4249-device" }, granted });
	return answered;
}
