// Part of #4272, RULING-112: flag off, in process == worker, both lane-free (legacy) even for a session with the lane.
import { existsSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const REPLY = "ok";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

/**
 * A record without its per-run values (ids, paths, timestamps, the faux api/model ids, prompt-sized usage): its
 * type, the UI request it makes, and each message's role, with an assistant message's content and stop reason.
 */
function shapeOf(record: WireRecord) {
	const message = record.message as { role?: string; content?: unknown; stopReason?: string } | undefined;
	return {
		type: record.type,
		...(typeof record.method === "string"
			? { method: record.method, key: record.widgetKey ?? record.statusKey }
			: {}),
		...(message?.role === undefined ? {} : { role: message.role }),
		...(message?.role === "assistant" ? { content: message.content, stopReason: message.stopReason } : {}),
	};
}

function turnOf(records: readonly WireRecord[]) {
	return records.slice(0, records.findIndex((record) => record.type === "agent_end") + 1).map(shapeOf);
}

async function inProcessTurn() {
	await using host = await statusHost();
	host.faux.setResponses([fauxAssistantMessage(REPLY, { timestamp: 1 })]);
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("legacy");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const ended = client.waitFor((record) => record.type === "agent_end" && record.sessionId === sessionId);
	expect((await client.request({ type: "prompt", sessionId, message: "hi" })).success).toBe(true);
	await ended;
	await host.writer.flush();
	return { lane: entry?.acceptance, turn: turnOf(client.inbox) };
}

async function workerTurn() {
	const host = await workerAcceptanceHost(builtFauxPath, "", `[fauxAssistantMessage("${REPLY}", { timestamp: 1 })]`);
	try {
		const { sessionId, worker } = await host.open();
		const ended = host.next("agent_end", (record) => record.type === "agent_end" && record.sessionId === sessionId);
		expect((await host.request({ type: "prompt", sessionId, message: "hi" })).success).toBe(true);
		await ended;
		await host.writer.flush();
		return { lane: worker.acceptance, turn: turnOf(host.records), failures: [...host.failures] };
	} finally {
		await host.dispose();
	}
}

it("in process: flag off, a session with the structured lane owns no acceptance lane", async () => {
	vi.stubEnv(FLAG, "0");
	const { lane, turn } = await inProcessTurn();
	expect(lane, "the in-process entry owns no SessionAcceptanceLane").toBeUndefined();
	expect(turn).toContainEqual(
		expect.objectContaining({ type: "message_end", role: "assistant", content: [{ type: "text", text: REPLY }] }),
	);
}, 600_000);

// Node only, like the other real-isolate cases: under the Bun vitest path a real isolate's structured lane sends no frame.
it.skipIf(process.versions.bun !== undefined)(
	"worker: flag off, the same session owns no acceptance lane and delivers the in-process legacy records",
	async ({ skip }) => {
		// The isolate loads the built faux provider (packages/ai/dist), which a source-only checkout does not have.
		if (!existsSync(builtFauxPath))
			skip(`needs the built faux provider at ${builtFauxPath}: build packages/ai first`);
		vi.stubEnv(FLAG, "0");
		const worker = await workerTurn();
		const inProcess = await inProcessTurn();
		expect(worker.failures).toEqual([]);
		expect(worker.lane, "the worker client owns no SessionAcceptanceLane").toBeUndefined();
		expect(inProcess.lane, "and neither does the in-process entry").toBeUndefined();
		expect(worker.turn.some((record) => record.type === "message_end" && record.role === "assistant")).toBe(true);
		expect(worker.turn, "the same ordered legacy records for open_session -> prompt -> agent_end").toEqual(
			inProcess.turn,
		);
	},
	600_000,
);
