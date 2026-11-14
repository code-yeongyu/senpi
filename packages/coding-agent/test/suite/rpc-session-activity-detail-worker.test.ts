/**
 * N3: a session in a worker isolate lists `errored`, its `error_code` and its `turn_id` from the snapshot its worker
 * publishes, as an in-process session does from its live runtime.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type DelegatedHost, type Peer, startHost, type WireRecord } from "./rpc-delegated-host-support.ts";

const FAUX = pathToFileURL(fileURLToPath(new URL("../../../ai/dist/providers/faux.js", import.meta.url))).href;

/** The worker's provider (the host opens worker sessions on `x307-faux/faux-1`), scripted to fail its one turn. */
const FAILING_PROVIDER = `import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(FAUX)};
export default function (pi) {
	const faux = fauxProvider({ api: "x307-faux", provider: "x307-faux", models: [{ id: "faux-1" }] });
	const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "rejected" });
	faux.setResponses([{ ...failed, providerDiagnostic: { category: "auth", httpStatus: 401, evidence: "structured_status" } }]);
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
	host = await startHost({ workers: true, workerExtensionSource: FAILING_PROVIDER });
	peer = await host.proven();
});
afterAll(async () => {
	await host.dispose();
});

async function frameNamed(label: string, predicate: (record: WireRecord) => boolean): Promise<WireRecord> {
	try {
		return await peer.frame(predicate);
	} catch (error) {
		throw new Error(`waiting for ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function statusOf(subscriptionId: unknown, sessionId: string, status: string) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		record.status === status;
}

it("a worker session whose turn failed lists errored with the failure's code and the turn's id", async () => {
	const subscribed = await peer.send({ type: "subscribe_sessions" });
	const subscriptionId = (subscribed.data as { subscriptionId?: unknown } | undefined)?.subscriptionId;
	const opened = await peer.send({ type: "open_session" });
	if (opened.success !== true) throw new Error(`open_session refused: ${JSON.stringify(opened)}`);
	const sessionId = String((opened.data as { sessionId?: unknown }).sessionId);

	const prompted = await peer.send({ type: "prompt", sessionId, message: "this turn fails" });
	if (prompted.success !== true) throw new Error(`prompt refused: ${JSON.stringify(prompted)}`);
	const turnId = (prompted.data as { turnId?: unknown }).turnId;
	expect(typeof turnId).toBe("string");
	const running = await frameNamed("session_status running", statusOf(subscriptionId, sessionId, "running"));
	await frameNamed(
		"session_status idle after running",
		(record) => statusOf(subscriptionId, sessionId, "idle")(record) && Number(record.seq) > Number(running.seq),
	);

	const { sessions } = (await peer.send({ type: "list_sessions" })).data as { sessions: WireRecord[] };
	expect(sessions.find((row) => row.sessionId === sessionId)).toMatchObject({
		activity: "errored",
		error_code: "auth",
		turn_id: turnId,
	});
}, 120_000);
