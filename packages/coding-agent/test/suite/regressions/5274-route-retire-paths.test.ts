import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";

vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs/promises");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// RULING-119 (#5274): every retire of a delivering route either follows a client action whose reply the client sees,
// or follows a typed record that ends the admission. One case per retire reason, at router level with the flag on.
async function compactHost() {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	return statusHost();
}

const open = (peer: RawClient, cwd: string, file: string, admissionId: string) =>
	peer.request({ type: "open_session", cwd, sessionPath: join(cwd, file), admissionId });

const taggedWith = (peer: RawClient, admissionId: string): WireRecord[] =>
	peer.inbox.filter((frame) => frame.admissionId === admissionId);

async function nothingAfter(
	host: Awaited<ReturnType<typeof statusHost>>,
	peer: RawClient,
	sessionId: string,
	id: string,
) {
	await host.writer.flush();
	const before = taggedWith(peer, id).length;
	for (const type of ["agent_start", "agent_idle"]) host.writer.enqueue(sessionId, { type });
	await host.writer.flush();
	expect(taggedWith(peer, id).length).toBe(before);
	expect(host.writer.routesAdmission(host.writer.socketEpochOf(peer.name) ?? "", id)).toBe(false);
}

it("RULING-119 reopen_superseded: the re-open's reply precedes the last record of the replaced route", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const first = await open(peer, host.cwd, "superseded.jsonl", "a");
	const second = await open(peer, host.cwd, "superseded.jsonl", "b");
	const sessionId = String(first.sessionId);
	await nothingAfter(host, peer, sessionId, "a");
	expect(peer.inbox.indexOf(taggedWith(peer, "a").at(-1) ?? {})).toBeLessThan(peer.inbox.indexOf(second));
}, 600_000);

it("RULING-119 client_detach: the detach's reply follows the route's last record", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const opened = await peer.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath: join(host.cwd, "detached.jsonl"),
		admissionId: "d",
		retain_on_disconnect: true,
	});
	const sessionId = String(opened.sessionId);
	const released = await peer.request({ type: "release_attachment", sessionId, admissionId: "d" });
	expect(released).toMatchObject({ success: true });
	await nothingAfter(host, peer, sessionId, "d");
	expect(peer.inbox.indexOf(taggedWith(peer, "d").at(-1) ?? {})).toBeLessThan(peer.inbox.indexOf(released));
}, 600_000);

it("RULING-119 mirror_unsubscribed: the unsubscribe reply precedes every end of the mirror's delivery", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const owner = host.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const subscribed = await peer.request({ type: "subscribe_sessions", admissionId: "m", mirror: "all" });
	const subscriptionId = String(dataOf(subscribed).subscriptionId);
	host.writer.enqueue(sessionId, { type: "agent_start" });
	await peer.waitFor((frame) => frame.type === "agent_start" && frame.admissionId === "m");
	const unsubscribed = await peer.request({ type: "unsubscribe_sessions", subscriptionId });
	expect(unsubscribed).toMatchObject({ success: true });
	await nothingAfter(host, peer, sessionId, "m");
	expect(peer.inbox.indexOf(taggedWith(peer, "m").at(-1) ?? {})).toBeLessThan(peer.inbox.indexOf(unsubscribed));
}, 600_000);

it("RULING-119 (3) open_ended: an accepted open whose terminal row fails ends with its tagged refusal last", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	let armed = true;
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		// The physical open succeeded and its records are already flowing under "lost"; only the durable row fails.
		if (armed && String(args[0]).includes("senpi-admissions-") && String(args[1]).includes('"state":"complete"')) {
			armed = false;
			throw Object.assign(new Error("fixture I/O"), { code: "EIO" });
		}
		return actual.writeFile(...args);
	});
	const failed = await open(peer, host.cwd, "lost.jsonl", "lost");
	expect(armed).toBe(false);
	expect(failed).toMatchObject({
		success: false,
		error: "admission_storage_unavailable",
		admissionId: "lost",
		generation: 1,
	});
	const tagged = taggedWith(peer, "lost");
	expect(tagged.some((frame) => frame.type === "session_opened")).toBe(true);
	expect(tagged.at(-1)).toBe(failed);
	expect(host.writer.routesAdmission(host.writer.socketEpochOf("peer") ?? "", "lost")).toBe(false);
}, 600_000);

it("RULING-119 open_ended: a cancelled late open ends with its tagged attempt_cancelled answer last", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const physical = RpcSessionRegistry.prototype.openSession;
	vi.spyOn(RpcSessionRegistry.prototype, "openSession").mockImplementationOnce(async function (
		this: RpcSessionRegistry,
		...args
	) {
		entered.resolve();
		await finish.promise;
		return physical.apply(this, args);
	});
	const pending = open(peer, host.cwd, "cancelled.jsonl", "late");
	try {
		await entered.promise;
		expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "late" }))).toEqual({
			outcome: "cancelled",
		});
	} finally {
		finish.resolve();
	}
	const answer = await pending;
	expect(answer).toMatchObject({ success: false, code: "attempt_cancelled", admissionId: "late", generation: 1 });
	await host.writer.flush();
	expect(taggedWith(peer, "late").at(-1)).toBe(answer);
	expect(host.writer.routesAdmission(host.writer.socketEpochOf("peer") ?? "", "late")).toBe(false);
}, 600_000);
