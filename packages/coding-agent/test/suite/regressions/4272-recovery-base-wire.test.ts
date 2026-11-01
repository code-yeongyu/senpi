import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { readFamilyRegistry } from "../../../src/modes/rpc/compact-catalog-registry.ts";
import type { RecoveryManifest } from "../../../src/modes/rpc/compact-recovery-manifest.ts";
import type { RecoveryCaller } from "../../../src/modes/rpc/compact-recovery-types.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { dataOf, type RawClient, statusHost } from "../rpc-session-status-support.ts";
import { type BaseEntry, fingerprintOf, stampedBytes, unwrap } from "./4272-base-file-support.ts";
import { componentText } from "./4272-frozen-bytes-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";

// Part of #4272 (S11c, RULING-70 (1), RULING-61): a real session opened from a transcript on disk has that transcript
// as its loaded base. Through the real router, the peer holding a token pages the base under `<catalogRoot>:base`
// and gets one stamped row per entry of the file, whose kinds and ids re-derive the catalog's idFingerprint; the
// families fed by those kinds are complete in that cut's catalog.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Host = Awaited<ReturnType<typeof statusHost>>;

function heldConnection(writer: SessionEventWriter, id: string): { release(): void } {
	let blocked = true;
	const waiters: (() => void)[] = [];
	writer.registerConnection(
		id,
		{
			writeRaw: () => undefined,
			waitForBackpressure: () =>
				blocked ? new Promise<void>((resolve) => void waiters.push(resolve)) : Promise.resolve(),
		},
		{ maxQueueBytes: 64 * 1024 * 1024 },
	);
	return {
		release: () => {
			blocked = false;
			for (const resolve of waiters.splice(0)) resolve();
		},
	};
}

async function turn(host: Host, client: RawClient, sessionId: string, message: string): Promise<void> {
	host.faux.setResponses([fauxAssistantMessage(`answer to ${message}`, { timestamp: 1 })]);
	const seen = client.inbox.filter((record) => record.type === "agent_idle").length;
	const idle = client.waitFor(
		(record) =>
			record.type === "agent_idle" && client.inbox.filter((each) => each.type === "agent_idle").length > seen,
	);
	dataOf(await client.request({ type: "prompt", sessionId, message }));
	await idle;
}

/** A transcript on disk: one real turn's file, copied under a new id, plus an unknown-kind entry and a label. */
async function transcriptOnDisk(host: Host, client: RawClient): Promise<{ path: string; entries: BaseEntry[] }> {
	const opened = dataOf(await client.request({ type: "open_session", cwd: host.cwd }));
	const sessionId = String(opened.sessionId);
	await turn(host, client, sessionId, "first");
	const state = dataOf(await client.request({ type: "get_state", sessionId }));
	const source =
		typeof state.sessionFile === "string" ? state.sessionFile : expect.unreachable("the session has a file");
	const lines = (await readFile(source, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as BaseEntry);
	const [header, ...rest] = lines;
	const last = rest.at(-1)?.id ?? expect.unreachable("the turn wrote entries");
	const entries: BaseEntry[] = [
		{ ...header, id: "copied-session" },
		...rest,
		{ type: "ext_timeline_group", id: "x1", parentId: last, group: { title: "g" } },
		{ type: "label", id: "l1", parentId: "x1", label: "note" },
	];
	const path = join(host.cwd, "copied.jsonl");
	await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { path, entries };
}

it("RULING-70 (1) a real session opened from a transcript on disk pages its loaded base over the wire as stamped rows; the families fed by it are complete", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	const first = host.client("first");
	const { path, entries } = await transcriptOnDisk(host, first);
	// Given: a second session opened from that file, with one more turn so the lane holds the base and new entries
	const second = host.client("second");
	const opened = dataOf(await second.request({ type: "open_session", cwd: host.cwd, sessionPath: path }));
	const routing = String(opened.sessionId);
	await turn(host, second, routing, "second");
	const held = heldConnection(host.writer, "held");
	try {
		host.writer.attachConnectionToSession("held", routing);
		const checkpoints = host.writer.recoveryCheckpoints;
		const token =
			checkpoints.tokens().find((candidate) => candidate.admission.peer === "held") ??
			expect.unreachable(`no token: ${JSON.stringify(checkpoints.status())}`);
		const caller: RecoveryCaller = { socketEpoch: token.admission.socketEpoch, sessionId: routing };
		const manifest: RecoveryManifest = unwrap(await checkpoints.catalog(token, caller));
		const root = unwrap(await checkpoints.readCatalog(token, caller, manifest.catalogRoot));
		if (root.kind !== "node") throw new Error("the catalog root is a node");
		const at = (kind: string, id: string) =>
			root.entries.findIndex((entry) => entry.kind === kind && entry.id === id);
		const text = async (kind: string, id: string) => {
			const index = at(kind, id);
			expect(index, `${kind}/${id} is cataloged`).toBeGreaterThanOrEqual(0);
			const ref = `${manifest.catalogRoot}:${String(index).padStart(3, "0")}`;
			const read = unwrap(await checkpoints.readCatalog(token, caller, ref));
			return read.kind === "component" ? componentText(read) : expect.unreachable("a component");
		};
		// Then: the cut's catalog names the loaded base in every family it feeds and its assembly is complete
		expect(JSON.parse(await text("transcript", "base"))).toEqual({
			source: "file",
			first: 0,
			count: entries.length,
			idFingerprint: fingerprintOf(entries),
		});
		expect(at("opaque", "base")).toBeGreaterThanOrEqual(0);
		expect(at("source", "base")).toBeGreaterThanOrEqual(0);
		expect(at("opaque", "opaque")).toBe(-1);
		expect(readFamilyRegistry(await text("families", "families")).assembly).toBe("complete");
		// When: the holder pages the base over the wire in cursor order
		const send = (fields: Record<string, unknown>): Promise<RpcResponse | undefined> =>
			host.writer.withConnection("held", () =>
				host.core.router.handle({
					id: "held-page",
					type: "get_recovery_page",
					sessionId: routing,
					token: token.id,
					admissionId: token.admission.admissionId,
					componentRef: `${manifest.catalogRoot}:base`,
					...fields,
				} as RpcCommand),
			);
		const pages: Buffer[] = [];
		let cursor: string | null = null;
		for (let ordinal = 1; ; ordinal++) {
			const answer = await send({ requestId: `r-${ordinal}`, ...(cursor === null ? {} : { cursor }) });
			expect(answer).toMatchObject({
				success: true,
				data: { ordinal, componentRef: `${manifest.catalogRoot}:base` },
			});
			const data = (answer as { data: { bytes: string; cursor: string | null; complete: boolean } }).data;
			pages.push(Buffer.from(data.bytes, "base64"));
			cursor = data.cursor;
			if (data.complete) break;
		}
		// Then: the join is one stamped row per entry of the file, and the rows alone re-derive the catalog's anchor
		const joined = Buffer.concat(pages);
		expect(joined.equals(stampedBytes(entries))).toBe(true);
		const rows = joined
			.toString("utf16le")
			.split("\n")
			.filter(Boolean)
			.map((row) => JSON.parse(row) as { kind: string; id: string; family: string });
		expect(rows.map(({ family }) => family).slice(-2)).toEqual(["opaque", "source"]);
		expect(fingerprintOf(rows.map(({ kind, id }) => ({ type: kind, id })))).toBe(fingerprintOf(entries));
	} finally {
		held.release();
		host.writer.unregisterConnection("held");
	}
});
