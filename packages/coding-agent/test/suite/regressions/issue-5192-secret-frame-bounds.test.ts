import { expect, it } from "vitest";
import { SESSION_WORKER_LIMITS } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { startWorkerHost, type WorkerHostRecord } from "../rpc-worker-host-support.ts";

// `/private-flood <count> <titleBytes>` opens that many secret inputs and leaves them pending.
const flood = `export default function(pi) {
	pi.registerCommand("private-flood", {description: "synthetic secret fixture", handler: async (args, ctx) => {
		const [count, titleBytes] = args.trim().split(" ").map(Number);
		for (let index = 0; index < count; index++)
			void ctx.ui.input("x".repeat(titleBytes), undefined, {secret: true}).catch(() => {});
	}});
}`;

const DENIED = "session_worker_output_denied";
const isInput = (record: WorkerHostRecord) => record.type === "extension_ui_request" && record.method === "input";

async function openSecretSession() {
	const host = await startWorkerHost(flood, { socket: true });
	const client = await host.connect();
	const opened = await client.request({ type: "open_session", cwd: host.cwd });
	expect(opened.success).toBe(true);
	const sessionId = opened.data?.sessionId;
	const info = await client.request({
		type: "set_client_info",
		sessionId,
		width: 80,
		capabilities: ["interactive_user", "secret_input_v1"],
	});
	expect(info.success).toBe(true);
	return { host, client, sessionId };
}

it("refuses an oversized secret frame before it reaches the presenter", async () => {
	const { host, client, sessionId } = await openSecretSession();
	try {
		const outcome = client.wait((record) => isInput(record) || record.error === DENIED);
		client.send({ type: "prompt", sessionId, message: `/private-flood 1 ${1024 * 1024}` });
		expect(await outcome).toMatchObject({ error: DENIED });
		expect(client.records.filter(isInput)).toHaveLength(0);
	} finally {
		await host.dispose();
	}
}, 60_000);

it("refuses a secret input opened beyond the concurrent cap", async () => {
	const { host, client, sessionId } = await openSecretSession();
	try {
		// Far above any cap, and below the endpoint's 512-record window, so the RED run sees every request.
		const opened = 200;
		let presented = 0;
		const outcome = client.wait((record) => (isInput(record) && ++presented === opened) || record.error === DENIED);
		client.send({ type: "prompt", sessionId, message: `/private-flood ${opened} 16` });
		expect(await outcome).toMatchObject({ error: DENIED });
		expect(presented).toBeLessThanOrEqual(SESSION_WORKER_LIMITS.secretInputs);
	} finally {
		await host.dispose();
	}
}, 60_000);
