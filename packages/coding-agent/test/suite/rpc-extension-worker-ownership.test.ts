import { once } from "node:events";
import { createConnection } from "node:net";
import { expect, it, onTestFinished } from "vitest";
import { endpoint, type WorkerHostRecord } from "./rpc-host-endpoint.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// #4728: real session isolates, real socket transports, contexts observed only through a loaded extension.
const extension = `export default function (pi) {
	// Session replacement reloads this extension, so the probe state lives on one worker-wide key: the
	// replacement instance must release, and count, the previous instance's held handler.
	const probe = (globalThis.__ownershipProbe ??= { gate: undefined, dispatched: 0, refused: 0 });
	pi.rpc.handle("probe.owner", (_data, context) =>
		context ? { ownerId: context.ownerId, aborted: context.disconnectSignal.aborted } : { supported: false });
	pi.rpc.handle("probe.hold", async (_data, context) => {
		if (!context) return { supported: false };
		probe.gate = Promise.withResolvers();
		pi.rpc.emit("probe.held", {});
		await probe.gate.promise;
		try {
			context.admit(() => { probe.dispatched += 1; });
		} catch {
			probe.refused += 1;
		}
		return { code: "123456" };
	});
	pi.rpc.handle("probe.release", () => {
		probe.gate?.resolve();
		return { released: probe.gate !== undefined };
	});
	pi.rpc.handle("probe.count", () => ({ dispatched: probe.dispatched, refused: probe.refused }));
}`;

async function workerHost() {
	const host = await startWorkerHost(extension, { socket: true });
	onTestFinished(() => host.dispose(), 30_000);
	const connect = async () => {
		const socket = createConnection(host.socketPath);
		await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
		const wire = endpoint(socket, socket, () => host.stderrText());
		onTestFinished(() => {
			wire.dispose();
			socket.destroy();
		});
		const step = (label: string, command: Record<string, unknown>) =>
			wire.request(command, 120_000).catch((cause: unknown) => {
				throw new Error(`${label}: ${cause instanceof Error ? cause.message.slice(0, 300) : String(cause)}`);
			});
		return {
			...wire,
			request: (command: Record<string, unknown>) =>
				step(String(command.type) + ":" + String(command.name ?? ""), command),
			close: () => socket.destroy(),
		};
	};
	const a = await connect();
	const b = await connect();
	await a.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
	const opened = await a.request({ type: "open_session", cwd: host.cwd });
	expect(opened.error ?? "opened").toBe("opened");
	const sessionId = String(opened.data?.sessionId);
	const attached = await b.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath: opened.data?.state?.sessionFile,
	});
	expect(attached.data?.attached).toBe(true);
	const call = (wire: typeof a, name: string) =>
		wire.request({ type: "extension_request", sessionId: attached.data?.sessionId ?? sessionId, name });
	return { host, a, b, sessionId, call };
}

const data = (record: WorkerHostRecord): Record<string, unknown> => {
	if (record.success !== true) throw new Error(`request failed: ${record.error}`);
	return { ...record.data };
};
const leaked = (records: readonly WorkerHostRecord[]) =>
	records.filter((record) => record.id === "a-held" || JSON.stringify(record).includes("123456"));

it("issues stable, distinct transport owners to extension handlers inside a session isolate", async () => {
	// Given: two real socket transports attached to one worker session.
	const { a, b, sessionId } = await workerHost();
	const owner = (wire: typeof a) =>
		wire.request({
			type: "extension_request",
			sessionId,
			name: "probe.owner",
			data: { ownerId: "spoofed" },
		});

	// When: both callers ask, then A asks again.
	const first = data(await owner(a));
	const other = data(await owner(b));
	const again = data(await owner(a));

	// Then: identity comes from the transport the host registered, never from the payload.
	expect(first.ownerId).toEqual(expect.any(String));
	expect(first.ownerId).not.toBe("spoofed");
	expect(other.ownerId).not.toBe(first.ownerId);
	expect(again).toEqual(first);
}, 120_000);

it("refuses an isolate effect after its transport retires and consumes the stale reply without failing the worker", async () => {
	// Given: A's handler is suspended inside the worker while B shares the session.
	const { host, a, b, sessionId } = await workerHost();
	const held = a.wait((record) => record.type === "extension_event" && record.name === "probe.held");
	a.send({ type: "extension_request", id: "a-held", sessionId, name: "probe.hold" });
	await held;
	const stdoutBefore = host.records.length;

	// When: A's socket drops, then B releases A's handler on the same isolate.
	a.close();
	await b.request({ type: "list_sessions" });
	const released = data(await b.request({ type: "extension_request", sessionId, name: "probe.release" }));
	const counts = data(await b.request({ type: "extension_request", sessionId, name: "probe.count" }));

	// Then: the shared gate refused the effect, no destination saw A's reply, and B's fresh request succeeds.
	expect(released).toEqual({ released: true });
	expect(counts).toEqual({ dispatched: 0, refused: 1 });
	const fresh = data(await b.request({ type: "extension_request", sessionId, name: "probe.owner" }));
	expect(fresh.aborted).toBe(false);
	expect(leaked(b.records)).toEqual([]);
	expect(leaked(host.records.slice(stdoutBefore))).toEqual([]);
}, 120_000);

it("retires the binding generation on session replacement while the transport keeps its owner", async () => {
	// Given: A's handler holds its captured gate across a replacement of the worker's session.
	const { a, b, sessionId } = await workerHost();
	const before = data(await a.request({ type: "extension_request", sessionId, name: "probe.owner" }));
	const held = a.wait((record) => record.type === "extension_event" && record.name === "probe.held");
	a.send({ type: "extension_request", id: "a-held", sessionId, name: "probe.hold" });
	await held;

	// When: B replaces the session, then releases A's suspended handler.
	expect((await b.request({ type: "new_session", sessionId })).success).toBe(true);
	await b.request({ type: "extension_request", sessionId, name: "probe.release" });
	const counts = data(await b.request({ type: "extension_request", sessionId, name: "probe.count" }));

	// Then: the old generation admits nothing and its reply reaches nobody, yet A's next request is live.
	expect(counts.dispatched).toBe(0);
	expect(counts.refused).toBe(1);
	const after = data(await a.request({ type: "extension_request", sessionId, name: "probe.owner" }));
	expect(after).toEqual({ ownerId: before.ownerId, aborted: false });
	expect(leaked(a.records)).toEqual([]);
	expect(leaked(b.records)).toEqual([]);
}, 120_000);
