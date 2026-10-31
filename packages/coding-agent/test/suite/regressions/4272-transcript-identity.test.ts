import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, fstat: vi.fn(actual.fstat) };
});

let dir = "";
const managers: SessionManager[] = [];
beforeEach(async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	vi.mocked(fs.fstat).mockReset().mockImplementation(actual.fstat);
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-identity-"));
});
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

function create() {
	const manager = SessionManager.create(dir, dir);
	managers.push(manager);
	return manager;
}

function snapshot(manager: SessionManager) {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	return lane;
}

// #4347 LOW-1: failed descriptor capture must not retain writer bytes or adopt the current pathname.
it("releases and disarms byte caches after identity capture fails, including rewrites", async () => {
	vi.mocked(fs.fstat).mockImplementation((...args) => {
		const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
		callback(new Error("injected fstat failure"));
	});
	const manager = create();
	const lane = snapshot(manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await manager.persistHeaderNow();
	const retainedBytes = () =>
		manager["fileEntries"].reduce(
			(total, entry) => total + Buffer.byteLength(manager["transcriptBytes"].get(entry) ?? ""),
			0,
		);
	expect(retainedBytes(), "failed first-flush capture releases cached writer bytes").toBe(0);
	for (let index = 0; index < 16; index++) {
		manager.appendMessage({ role: "user", content: `next ${index}`, timestamp: index + 2 });
		manager.appendCustomEntry("next", { index });
		expect(retainedBytes(), "later appends cannot rearm the failed lifecycle").toBe(0);
	}
	for (let index = 0; index < 3; index++) {
		manager["_rewriteFile"]();
		expect(retainedBytes(), "a rewrite cannot cache the known-unavailable transcript").toBe(0);
		await manager.persistHeaderNow();
		manager.appendCustomEntry("after rewrite", { index });
		expect(retainedBytes(), "failed replacement capture also disarms caching").toBe(0);
	}
	lane.applyTranscript(manager.drainTranscript());
	for (const current of [lane, snapshot(manager)]) {
		expect(readTranscriptRoot(current.freeze().transcript)).toEqual({
			ok: false,
			error: "transcript_file_identity_unavailable",
		});
	}
});

// #4347 LOW-2: a late first-flush fstat cannot publish into a newer session lifecycle.
it("ignores a superseded first-flush capture after newSession has flushed", async () => {
	const realStat = vi.mocked(fs.fstat).getMockImplementation();
	if (!realStat) throw new Error("real fstat implementation is installed");
	let releaseOld: (() => void) | undefined;
	vi.mocked(fs.fstat).mockImplementationOnce((...args) => {
		releaseOld = () => realStat(...args);
	});
	const manager = create();
	manager.beginTranscriptJournal();
	manager.appendMessage({ role: "user", content: "old lifecycle", timestamp: 1 });
	const oldFile = manager.getSessionFile();
	const oldReady = manager["transcriptFile"].ready;
	manager.newSession();
	manager.appendMessage({ role: "user", content: "new lifecycle", timestamp: 2 });
	await manager.persistHeaderNow();
	const lane = snapshot(manager);
	const before = lane.freeze().transcript;
	const beforeRead = readTranscriptRoot(before);
	expect(beforeRead.ok && beforeRead.entries.at(-1)).toMatchObject({
		message: { content: "new lifecycle" },
	});
	expect(before.tail.persistence?.fileIdentity.path).toBe(manager.getSessionFile());
	if (!releaseOld) throw new Error("old descriptor capture was deferred");
	releaseOld();
	await oldReady;
	const transitions = manager.drainTranscript();
	for (const transition of transitions) {
		if (transition.kind === "persisted") expect(transition.persistence.fileIdentity.path).not.toBe(oldFile);
		if (transition.kind === "replace") expect(transition.base?.fileIdentity.path).not.toBe(oldFile);
	}
	lane.applyTranscript(transitions);
	expect(readTranscriptRoot(lane.freeze().transcript)).toEqual(beforeRead);
	expect(readTranscriptRoot(snapshot(manager).freeze().transcript)).toEqual(beforeRead);
});

// #4347 / RULING-31(2): the first publication must name the descriptor we wrote, not a later pathname.
it("R31.2 replacement between create and first publish fails instead of adopting the replacement", async () => {
	const manager = create();
	manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	const file = String(manager.getSessionFile());
	fs.writeFileSync(`${file}.next`, fs.readFileSync(file));
	fs.renameSync(`${file}.next`, file);
	await manager.persistHeaderNow();
	const lane = snapshot(manager);
	expect(readTranscriptRoot(lane.freeze().transcript)).toEqual({ ok: false, error: "base_file_replaced" });
});

it.each(["header", "atomic replacement"] as const)(
	"R31.2 %s captures its own descriptor even when the path changes before fstat",
	async (lifecycle) => {
		const manager = create();
		let id: string | undefined;
		if (lifecycle === "atomic replacement") {
			id = manager.appendMessage({ role: "user", content: "branch source", timestamp: 1 });
			await manager.persistHeaderNow();
		}
		const realStat = vi.mocked(fs.fstat).getMockImplementation();
		if (!realStat) throw new Error("real fstat implementation is installed");
		vi.mocked(fs.fstat).mockImplementationOnce((...args) => {
			const file = String(manager.getSessionFile());
			// Atomic replacement is still writing its temp fd: replacing the destination now would
			// precede its own rename. Replace immediately after the method returns instead.
			if (lifecycle === "header") {
				fs.writeFileSync(`${file}.next`, fs.readFileSync(file));
				fs.renameSync(`${file}.next`, file);
			}
			return realStat(...args);
		});
		if (id) {
			const file = String(manager.createBranchedSession(id));
			fs.writeFileSync(`${file}.next`, fs.readFileSync(file));
			fs.renameSync(`${file}.next`, file);
		}
		await manager.persistHeaderNow();
		expect(readTranscriptRoot(snapshot(manager).freeze().transcript)).toEqual({
			ok: false,
			error: "base_file_replaced",
		});
	},
);

// #4347 / RULING-31(3): a captured descriptor never authorizes different history at the same inode.
it.each(["truncate", "rewrite"] as const)("R31.3 %s after capture is a typed failure", async (change) => {
	const manager = create();
	manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	await manager.persistHeaderNow();
	const lane = snapshot(manager);
	const held = lane.freeze();
	const file = String(manager.getSessionFile());
	if (change === "truncate") fs.truncateSync(file, 0);
	else {
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const entry = JSON.parse(lines[1] ?? "");
		lines[1] = JSON.stringify({ ...entry, id: `${entry.id}-rewritten` });
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
	}
	expect(readTranscriptRoot(held.transcript)).toEqual({
		ok: false,
		error: change === "truncate" ? "base_file_truncated" : "base_fingerprint_mismatch",
	});
});

// #4347 / RULING-31(4): same-turn snapshots cannot observe an asynchronous fstat result.
it("R31.4 snapshot before identity lands serves the bounded tail and then releases it", async () => {
	const manager = create();
	const stringify = vi.spyOn(JSON, "stringify");
	manager.appendMessage({ role: "user", content: "tail before identity", timestamp: 1 });
	const written = stringify.mock.calls.length;
	const lane = snapshot(manager);
	expect(stringify.mock.calls.length, "the pending snapshot reuses writer bytes").toBe(written);
	const held = lane.freeze();
	expect(held.transcript.base).toBeNull();
	expect(held.transcript.tail.persistence).toBeNull();
	expect(held.transcript.tail.retainedBytes).toBeGreaterThan(0);
	const before = readTranscriptRoot(held.transcript);
	expect(before.ok && before.entries.at(-1)).toMatchObject({ message: { content: "tail before identity" } });
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	expect(held.transcript.tail.retainedBytes).toBe(0);
	expect(readTranscriptRoot(held.transcript)).toEqual(before);
});

// #4347 / RULING-31: append and repeat flush reuse the first descriptor capture.
it("captures once for each create and atomic replacement, never for appends or repeat flushes", async () => {
	const stat = vi.mocked(fs.fstat).mockClear();
	const manager = create();
	const id = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await manager.persistHeaderNow();
	expect(stat).toHaveBeenCalledTimes(1);
	for (let index = 0; index < 8; index++) manager.appendCustomEntry("next", { index });
	await manager.persistHeaderNow();
	expect(stat).toHaveBeenCalledTimes(1);
	manager.createBranchedSession(id);
	const pending = snapshot(manager);
	expect(pending.freeze().transcript.tail.persistence).toBeNull();
	await manager.persistHeaderNow();
	expect(stat).toHaveBeenCalledTimes(2);
	pending.applyTranscript(manager.drainTranscript());
	expect(pending.freeze().transcript.tail.retainedBytes).toBe(0);
});
