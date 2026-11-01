import { join } from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ADMISSION_LIMITS } from "../../../src/modes/rpc/compact-admissions.ts";
import { type RawClient, statusHost } from "../rpc-session-status-support.ts";

vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs/promises");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// RULING-117 (#5274): a completed re-open of a session on the same socket replaces that socket's route to it, so
// routed rows are bounded by the distinct sessions a socket holds, never by how often it re-opens one. 2,000 re-opens
// turn the 127-row cap over ~15 times; the ruling's 10,000 also passed, in a 308 s file run that it dominated.
const REOPENS = 2_000;

async function compactHost() {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	return statusHost();
}

const open = (peer: RawClient, cwd: string, file: string, admissionId: string) =>
	peer.request({ type: "open_session", cwd, sessionPath: join(cwd, file), admissionId });

it("RULING-117 2,000 re-opens of one session on one socket are all admitted; only the latest id still routes", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	let sessionId = "";
	for (let n = 0; n < REOPENS; n++) {
		const opened = await open(peer, host.cwd, "reopened.jsonl", `open-${n}`);
		if (opened.success !== true) expect(opened, `re-open ${n}`).toMatchObject({ success: true });
		sessionId = String(opened.sessionId);
	}
	const latest = `open-${REOPENS - 1}`;
	expect(await peer.request({ type: "reset_stream", sessionId, admissionId: latest })).toMatchObject({
		success: true,
		sessionId,
		admissionId: latest,
	});
	for (const old of [`open-${REOPENS - 2}`, "open-0"])
		expect(await peer.request({ type: "reset_stream", sessionId, admissionId: old })).toMatchObject({
			success: false,
			code: "unknown_admission",
			admissionId: old,
		});
}, 600_000);

it("RULING-117 a failed re-open keeps the earlier route live", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const first = await open(peer, host.cwd, "kept.jsonl", "first");
	const sessionId = String(first.sessionId);
	let armed = true;
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		// The re-open's durable terminal row fails after its physical open succeeded: it never completes.
		if (armed && String(args[0]).includes("senpi-admissions-") && String(args[1]).includes('"state":"complete"')) {
			armed = false;
			throw Object.assign(new Error("fixture I/O"), { code: "EIO" });
		}
		return actual.writeFile(...args);
	});
	const failed = await open(peer, host.cwd, "kept.jsonl", "second");
	expect(armed).toBe(false);
	expect(failed).toMatchObject({ success: false, error: "admission_storage_unavailable" });
	expect(await peer.request({ type: "reset_stream", sessionId, admissionId: "first" })).toMatchObject({
		success: true,
		sessionId,
		admissionId: "first",
	});
}, 600_000);

it("RULING-117 a C4.4 retry of an earlier id answers from its row and supersedes nothing", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	await open(peer, host.cwd, "retried.jsonl", "a");
	const reopened = await open(peer, host.cwd, "retried.jsonl", "b");
	const sessionId = String(reopened.sessionId);
	expect(await open(peer, host.cwd, "retried.jsonl", "a")).toMatchObject({ success: true, admissionId: "a" });
	expect(await peer.request({ type: "reset_stream", sessionId, admissionId: "b" })).toMatchObject({
		success: true,
		admissionId: "b",
	});
	expect(await peer.request({ type: "reset_stream", sessionId, admissionId: "a" })).toMatchObject({
		success: false,
		code: "unknown_admission",
	});
	expect(await open(peer, host.cwd, "retried.jsonl", "b")).toMatchObject({ success: true, admissionId: "b" });
	expect(await peer.request({ type: "reset_stream", sessionId, admissionId: "b" })).toMatchObject({
		success: true,
		admissionId: "b",
	});
}, 600_000);

it("RULING-117 the 128th distinct session on one socket is refused admission_limit", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const distinct = ADMISSION_LIMITS.entries - 1;
	for (let n = 0; n < distinct; n++) {
		const opened = await open(peer, host.cwd, `distinct-${n}.jsonl`, `distinct-${n}`);
		if (opened.success !== true) expect(opened, `distinct ${n}`).toMatchObject({ success: true });
	}
	expect(await open(peer, host.cwd, "one-too-many.jsonl", "one-too-many")).toMatchObject({
		success: false,
		error: "admission_admission_limit",
	});
}, 600_000);
