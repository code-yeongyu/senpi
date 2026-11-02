import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { compareAdmissionGoldens } from "./4272-admission-golden-support.ts";
import { EVENT_SAFETY_MS } from "./4272-worker-acceptance-support.ts";
import { FLAG, reconnect, recoveredRows } from "./5331-live-identity-support.ts";
import { toolUse } from "./5346-stamp-host-support.ts";

// senpi#5348 (RULING-123 C3.4, RULING-122's fail-safe rule): two calls reusing one toolCallId inside ONE assistant
// message are reduced oldest-open-first, so which execution state, hook, result and carrier belongs to which of them is
// an order join. Their live execution records already say `callUnknown` (#5346); the snapshot rows a reconnecting
// compact peer pages, the outstanding `calls` members and the `settled` toolResult rows they retire into, must say so
// too, so a consumer never shows the two calls' states swapped as fact.

const DUP = "dup";
type Host = Awaited<ReturnType<typeof statusHost>>;
let host: Host | undefined;
afterEach(async () => {
	await host?.[Symbol.asyncDispose]();
	host = undefined;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const rows = (cut: ReadonlyMap<string, Record<string, unknown>>, kind: string) =>
	[...cut].filter(([key]) => key.startsWith(`${kind}/`)).map(([, row]) => row);
const terminalOf = (row: Record<string, unknown>) =>
	(row.payload as { terminal?: Record<string, unknown> } | undefined)?.terminal ?? {};

/**
 * Golden k, the desktop decoder's pin for the marker shape: every `calls` member of the held cut and every `settled`
 * member after the run, as paged, in member order (settled rows page in the order of their random message ids). Keys
 * are pinned as their rank and `hookRunId` (a host-wide hook counter) is masked, like golden j.
 */
function golden(...cuts: ReadonlyMap<string, Record<string, unknown>>[]): unknown {
	const keys: unknown[] = [];
	const pin = (value: unknown, key?: string): unknown => {
		if (key === "hookRunId") return "<hook-run>";
		if (key === "runtimeItemKey" && typeof value === "string") {
			if (!keys.includes(value)) keys.push(value);
			return `call-${keys.indexOf(value) + 1}`;
		}
		if (Array.isArray(value)) return value.map((item: unknown) => pin(item));
		if (typeof value !== "object" || value === null) return value;
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, pin(item, name)]));
	};
	const members = cuts.flatMap((cut) => [...cut]).sort(([a], [b]) => (a < b ? -1 : 1));
	return { snapshot: Object.fromEntries(members.map(([member, row]) => [member, pin(row)])) };
}

it("RULING-123 C3.4 #5348 snapshot calls and settled rows of a toolCallId reused within one message are marked callUnknown", async () => {
	vi.stubEnv(FLAG, "1");
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T00:00:00.000Z") });
	// A fixed chunk size: the faux provider otherwise draws one per delta, which moves every lane sequence.
	host = await statusHost({ tokenSize: { min: 64, max: 64 } });
	const run = host;
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const legacy = run.client("legacy");
	const routing = String(dataOf(await legacy.request({ type: "open_session", cwd: run.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	const session = entry?.runtime?.session ?? expect.unreachable("no in-process session");
	run.client("compact");
	run.writer.setConnectionCapabilities("compact", ["compact_events"]);
	run.writer.attachConnectionToSession("compact", routing);
	const lane = { host: run, routing, lane: entry?.acceptance };

	// The first PreToolUse hook holds while a reconnected peer freezes a cut: both calls are outstanding `calls` rows.
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let first = true;
	const api = run.extensionApis.get(session.sessionManager.getSessionId()) ?? expect.unreachable("no extension api");
	api.on("tool_call", async () => {
		if (!first) return undefined;
		first = false;
		reached.resolve();
		await released.promise;
		return undefined;
	});
	// Both toolResult writes are refused, so each carrier keeps a failed `settled` row with the call it retired.
	const append = session.sessionManager.appendOwnedMessage.bind(session.sessionManager);
	vi.spyOn(session.sessionManager, "appendOwnedMessage").mockImplementation((message, options) => {
		if (message.role === "toolResult") throw new Error("EACCES: injected transcript failure");
		return append(message, options);
	});

	run.faux.setResponses([
		toolUse(
			fauxToolCall("read", { path: "first.txt" }, { id: DUP }),
			fauxToolCall("read", { path: "second.txt" }, { id: DUP }),
		),
		fauxAssistantMessage("done", { timestamp: 1 }),
	]);
	const idle = (record: WireRecord) => record.type === "agent_idle" && record.sessionId === routing;
	const done = legacy.waitFor(idle, EVENT_SAFETY_MS);
	dataOf(await legacy.request({ type: "prompt", sessionId: routing, message: "go" }));
	await Promise.race([reached.promise, done.then(() => expect.unreachable("the hook was never reached"))]);
	await run.writer.flush();
	await reconnect(lane, "compact", "compact-again");
	const held = await recoveredRows(lane, "compact-again", ["calls"]);
	released.resolve();
	await done;
	await run.writer.flush();
	await reconnect(lane, "compact-again", "compact-settled");
	const settled = await recoveredRows(lane, "compact-settled", ["settled"]);

	const calls = rows(held, "calls").filter((row) => row.toolCallId === DUP);
	expect(calls, "both calls are outstanding rows of the held cut").toHaveLength(2);
	expect(new Set(calls.map((row) => row.contentIndex))).toEqual(new Set([0, 1]));
	for (const row of calls)
		expect(row, `calls row of block ${String(row.contentIndex)}`).toMatchObject({ callUnknown: true });

	const carriers = rows(settled, "settled").filter(
		(row) => row.role === "toolResult" && terminalOf(row).toolCallId === DUP,
	);
	expect(carriers, "both refused toolResults keep a settled row").toHaveLength(2);
	for (const row of carriers) {
		expect(row, "the settled row the carrier joins by").toMatchObject({ status: "failed", callUnknown: true });
		expect(row.call, "the call projection it retired").toMatchObject({ toolCallId: DUP, callUnknown: true });
	}
	const unmarked = [...calls, ...carriers, ...carriers.map((row) => row.call as Record<string, unknown>)].filter(
		(row) => row.callUnknown !== true,
	);
	expect(unmarked).toEqual([]);
	await compareAdmissionGoldens({ "k-same-message-reused-id.json": golden(held, settled) }, dirname(run.cwd));
}, 600_000);
