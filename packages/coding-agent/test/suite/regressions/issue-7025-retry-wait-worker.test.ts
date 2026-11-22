/**
 * senpi#7025 review M1/L1: a session in a worker isolate publishes the retry wait on its OWN `session_status`
 * record, and the `list_sessions` row carries the wait without the provider's error text.
 *
 * The host derives a worker session's view from the last snapshot its worker sent, and an `output` frame
 * replaces that snapshot only for the records listed in `session-worker.ts`. `auto_retry_start` and
 * `auto_retry_end` were not on that list, so the `retry` cause published with no `waiting` and the wait
 * surfaced only on the retried request's `agent_start`, after it had already ended - the reverse of the
 * contract, and only for worker-hosted sessions.
 *
 * Test authoring gate: (1) the contract is the `session_status`/`list_sessions` wire shape for a worker
 * runtime, the default for stdio hosts; (2) the regression is a record that changes the wait but is not on
 * the replacement-snapshot list, which is exactly what shipped; (3) the in-process tests cover only
 * `sessionRuntimeView` and the pure derive function, so no existing test crosses the isolate boundary;
 * (4) no production seam is added - the test drives the real host over its real socket.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type DelegatedHost, type Peer, startHost, type WireRecord } from "../rpc-delegated-host-support.ts";

const FAUX = pathToFileURL(fileURLToPath(new URL("../../../../ai/dist/providers/faux.js", import.meta.url))).href;

/** The worker-side provider: one 429 turn, then a recovered one, so the session sleeps in a retry backoff. */
const WORKER_EXTENSION = `import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(FAUX)};
export default function (pi) {
	const faux = fauxProvider({ api: "fauxsock", provider: "fauxsock" });
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate_limit_exceeded: slow down" }),
		fauxAssistantMessage("recovered"),
	]);
	pi.registerProvider(faux.provider);
}
`;

let host: DelegatedHost;
let peer: Peer;

beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
});
beforeAll(async () => {
	host = await startHost({ workers: true, workerExtensionSource: WORKER_EXTENSION });
	// A backoff long enough to read the listing while the session still sleeps, short enough to keep the test quick.
	await writeFile(join(host.scratch, "agent", "settings.json"), JSON.stringify({ retry: { baseDelayMs: 3000 } }));
	peer = await host.proven();
});
afterAll(async () => {
	await host.dispose();
});

function retryStatus(subscriptionId: unknown, sessionId: string) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		(record.lastChange as { cause?: unknown } | undefined)?.cause === "retry";
}

it("a worker session publishes the retry wait on its own status record and lists it without the error text", async () => {
	const subscribed = await peer.send({ type: "subscribe_sessions" });
	const subscriptionId = (subscribed.data as { subscriptionId?: unknown } | undefined)?.subscriptionId;
	const opened = await peer.send({ type: "open_session", provider: "fauxsock", modelId: "faux-1" });
	if (opened.success !== true) throw new Error(`open_session refused: ${JSON.stringify(opened)}`);
	const sessionId = String((opened.data as { sessionId?: unknown }).sessionId);

	const prompted = peer.send({ type: "prompt", sessionId, message: "test" });
	const started = await peer.frame(retryStatus(subscriptionId, sessionId));
	expect(started).toMatchObject({
		status: "running",
		waiting: { kind: "rate_limit", attempt: 1, maxAttempts: 5 },
	});
	const waiting = started.waiting as { delayMs?: unknown; until?: unknown; error?: unknown };
	expect(typeof waiting.delayMs).toBe("number");
	expect(Number.isNaN(Date.parse(String(waiting.until)))).toBe(false);
	expect(String(waiting.error)).toContain("429");

	const { sessions } = (await peer.send({ type: "list_sessions" })).data as {
		sessions: Array<Record<string, unknown>>;
	};
	const row = sessions.find((candidate) => candidate.sessionId === sessionId);
	expect(row).toMatchObject({ activity: "running", waiting: { kind: "rate_limit", attempt: 1, maxAttempts: 5 } });
	expect(row?.waiting).not.toHaveProperty("error");

	await prompted;
});
