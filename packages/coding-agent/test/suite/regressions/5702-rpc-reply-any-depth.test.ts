import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { RPC_ERROR_RESPONSE_UNWRITABLE } from "../../../src/modes/rpc/rpc-error-types.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// senpi#5702 (the relay daemon's tracking issue): an RPC reply is written at any nesting depth, and a reply that still
// cannot be written answers its request id with a typed `response_unwritable` error instead of a stderr-only refusal
// and a caller that waits forever. Protects the RPC response protocol contract (every method's reply reaches its id).

/** Each `get_tree` entry is the child of the previous one, so the tree nests one level per entry. */
const ENTRIES = 10_000;

/** A session file of `count` chained custom entries: the cheap way to a long session, no model calls. */
function chainedSession(cwd: string, count: number): string {
	const timestamp = new Date(0).toISOString();
	const lines = [JSON.stringify({ type: "session", version: 3, id: "deep-tree", timestamp, cwd })];
	let parentId: string | null = null;
	for (let index = 0; index < count; index++) {
		const id = `e${index.toString(16).padStart(8, "0")}`;
		lines.push(JSON.stringify({ type: "custom", customType: "chain", data: { index }, id, parentId, timestamp }));
		parentId = id;
	}
	return `${lines.join("\n")}\n`;
}

function expectWholeChain(response: WireRecord | undefined, count: number): void {
	expect(response).toMatchObject({ type: "response", command: "get_tree", success: true });
	expect(Object.keys(response?.data as object).sort()).toEqual(["leafId", "tree"]);
	const data = response?.data as { tree: { entry: { id: string }; children: unknown[] }[]; leafId: string };
	expect(data.tree).toHaveLength(1);
	let node = data.tree[0];
	let depth = 0;
	let lastId = "";
	while (node) {
		// The session's own startup bookkeeping entries follow the chain.
		if (depth < count) expect(node.entry.id).toBe(`e${depth.toString(16).padStart(8, "0")}`);
		lastId = node.entry.id;
		depth++;
		const children = node.children as (typeof node)[];
		expect(children.length).toBeLessThanOrEqual(1);
		node = children[0] as typeof node;
	}
	expect(depth).toBeGreaterThanOrEqual(count);
	expect(data.leafId).toBe(lastId);
}

afterEach(() => {
	vi.restoreAllMocks();
});

it(`in process: get_tree on ${ENTRIES} chained entries reaches the client whole, and the session keeps serving`, async () => {
	await using host = await statusHost();
	const client = host.client("deep");
	const sessionPath = join(host.cwd, "deep.jsonl");
	await writeFile(sessionPath, chainedSession(host.cwd, ENTRIES));
	const sessionId = String(
		dataOf(await client.request({ type: "open_session", cwd: host.cwd, sessionPath })).sessionId,
	);
	expectWholeChain(await client.request({ type: "get_tree", sessionId }), ENTRIES);
	expect((await client.request({ type: "get_state", sessionId })).success).toBe(true);
	expect(host.writer.legacyRefusals.count).toBe(0);
}, 120_000);

it(`worker: get_tree on ${ENTRIES} chained entries reaches the client whole, and the worker lives`, async () => {
	const host = await workerAcceptanceHost(builtFauxPath);
	try {
		const sessionPath = join(host.dir, "deep.jsonl");
		await writeFile(sessionPath, chainedSession(host.dir, ENTRIES));
		const opened = await host.request(
			{ type: "open_session", cwd: host.dir, sessionPath, provider: "faux", modelId: "faux-1" },
			75_000,
		);
		expect(opened.success, JSON.stringify(opened.error)).toBe(true);
		const sessionId = String((opened.data as { sessionId: string }).sessionId);
		expectWholeChain(await host.request({ type: "get_tree", sessionId }), ENTRIES);
		expect((await host.request({ type: "get_state", sessionId })).success).toBe(true);
		expect(host.failures, "the worker was not ended").toEqual([]);
		expect(host.writer.legacyRefusals.count).toBe(0);
	} finally {
		await host.dispose();
	}
}, 180_000);

/** A chain past every engine's recursive limit: a `Date` leaf makes native JSON recurse on every engine (Node 26 too). */
const deepChain = (depth: number) => {
	let node: unknown = { entry: { id: "leaf", at: new Date(0) }, children: [] };
	for (let level = 0; level < depth; level++) node = { entry: { id: `n${level}` }, children: [node] };
	return [node];
};
const cyclic = () => {
	const message: Record<string, unknown> = { role: "user", content: "hi", timestamp: 1 };
	message.self = message;
	return [message];
};

type Row = {
	readonly name: string;
	readonly command: Record<string, unknown>;
	/** Stubs only the session dependency the real handler reads; router, handler, binding and writer run for real. */
	readonly inject: () => void;
	/** undefined: the reply is written; otherwise the cause its typed error names. */
	readonly unwritable?: RegExp;
};

const rows: readonly Row[] = [
	{
		name: "get_tree past every engine's recursive JSON limit is written whole",
		command: { type: "get_tree" },
		inject: () => {
			vi.spyOn(SessionManager.prototype, "getTree").mockReturnValue(deepChain(65_536) as never);
		},
	},
	{
		name: "get_tree whose entry's toJSON throws",
		command: { type: "get_tree" },
		inject: () => {
			const entry = {
				toJSON() {
					throw new Error("entry not serializable");
				},
			};
			vi.spyOn(SessionManager.prototype, "getTree").mockReturnValue([{ entry, children: [] }] as never);
		},
		unwritable: /Error: entry not serializable/,
	},
	{
		name: "get_messages with a cycle",
		command: { type: "get_messages" },
		inject: () => {
			vi.spyOn(AgentSession.prototype, "messages", "get").mockReturnValue(cyclic() as never);
		},
		unwritable: /TypeError: Converting circular structure to JSON/,
	},
	{
		name: "get_session_stats with a BigInt",
		command: { type: "get_session_stats" },
		inject: () => {
			vi.spyOn(AgentSession.prototype, "getSessionStats").mockReturnValue({ tokens: 1n } as never);
		},
		unwritable: /TypeError: Do not know how to serialize a BigInt/,
	},
	{
		name: "get_last_assistant_text with a boxed BigInt",
		command: { type: "get_last_assistant_text" },
		inject: () => {
			vi.spyOn(AgentSession.prototype, "getLastAssistantText").mockReturnValue(Object(1n) as never);
		},
		unwritable: /TypeError: Do not know how to serialize a BigInt/,
	},
];

it.each(rows)(
	"in process: $name - exactly one answer for its id, then the session keeps serving",
	async (row) => {
		await using host = await statusHost();
		const client = host.client("table");
		const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(String(chunk)) > 0);
		row.inject();
		const response = await client.request({ ...row.command, sessionId });
		vi.restoreAllMocks();
		await host.writer.flush();
		const answers = client.inbox.filter((record) => record.type === "response" && record.id === response.id);
		expect(answers, "exactly one reply for the request id").toHaveLength(1);
		const command = row.command.type;
		if (row.unwritable === undefined) {
			expect(response).toMatchObject({ type: "response", command, success: true });
			expect(host.writer.legacyRefusals.count).toBe(0);
			expect(stderr.filter((line) => line.includes("unwritable"))).toEqual([]);
		} else {
			expect(Object.keys(response).sort()).toEqual(
				["command", "error", "errorCode", "id", "sessionId", "success", "type"].sort(),
			);
			expect(response).toMatchObject({
				type: "response",
				command,
				success: false,
				errorCode: RPC_ERROR_RESPONSE_UNWRITABLE,
				sessionId,
			});
			expect(String(response.error)).toMatch(row.unwritable);
			expect(String(response.error)).not.toContain("\n");
			expect(host.writer.legacyRefusals.count, "counted once").toBe(1);
			expect(
				stderr.filter(
					(line) =>
						line.startsWith(`senpi rpc host: ${command} response unwritable (`) &&
						line.endsWith(`; answered ${RPC_ERROR_RESPONSE_UNWRITABLE} (session ${sessionId})\n`),
				),
				"reported once",
			).toHaveLength(1);
		}
		expect((await client.request({ type: "get_state", sessionId })).success, "the session keeps serving").toBe(true);
	},
	120_000,
);
