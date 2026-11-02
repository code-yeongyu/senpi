import { afterEach, expect, it, vi } from "vitest";
import { ADMISSION_LIMITS, CompactAdmissionError, CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import { admissionClient } from "./4272-rpc-client-admission-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// RULING-125 (#5285) on the epoch index: a marked retry of an id the index no longer holds as a row (evicted into the
// ring, or forgotten after the ring overflowed: the RULING-114 residual) answers admission_unknown and never runs again.
// Unmarked, an evicted id still answers admission_retired and a forgotten one still runs as a fresh admission.
const identity = (admissionId: string, retry?: true) => ({
	socketEpoch: "epoch-1",
	peer: "peer",
	admissionId,
	fingerprint: "a".repeat(64),
	...(retry ? { retry } : {}),
});
const oneRow = { entries: 1, bytes: ADMISSION_LIMITS.row };
const answering = () => vi.fn(async () => ({ answer: { sessionId: "session-1" }, release: async () => {} }));

it("RULING-125 an evicted id answers admission_unknown with retry:true and admission_retired without it", async () => {
	const index = new CompactAdmissions(oneRow);
	const produce = answering();
	try {
		await index.run(identity("evicted"), produce);
		await index.run(identity("newer"), produce);
		await expect(index.run(identity("evicted", true), produce)).rejects.toMatchObject({
			reason: "admission_unknown",
		});
		await expect(index.run(identity("evicted"), produce)).rejects.toMatchObject({ reason: "admission_retired" });
		expect(produce).toHaveBeenCalledTimes(2);
	} finally {
		await index.dispose();
	}
});

it("RULING-125 a retry older than the ring answers admission_unknown and is never re-run", async () => {
	const index = new CompactAdmissions(oneRow);
	const produce = answering();
	const runs = ADMISSION_LIMITS.retired + 2;
	try {
		for (let id = 0; id < runs; id++) await index.run(identity(`id-${id}`), produce);
		expect(index.status().retiredOverflow).toBe(1);
		const retried = index.run(identity("id-0", true), produce);
		await expect(retried).rejects.toBeInstanceOf(CompactAdmissionError);
		await expect(retried).rejects.toMatchObject({ reason: "admission_unknown" });
		expect(produce).toHaveBeenCalledTimes(runs);
		// Unmarked, the forgotten id is indistinguishable from a fresh open, as before RULING-125.
		await index.run(identity("id-0"), produce);
		expect(produce).toHaveBeenCalledTimes(runs + 1);
	} finally {
		await index.dispose();
	}
}, 600_000);

it("RULING-125 the in-repo client marks every re-send of an admission id with retry:true", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using fixture = await admissionClient();
	const { host, client, requests } = fixture;
	const run = CompactAdmissions.prototype.run;
	vi.spyOn(CompactAdmissions.prototype, "run")
		.mockRejectedValueOnce(new CompactAdmissionError("storage_unavailable"))
		.mockImplementation(function (this: CompactAdmissions, ...args) {
			return run.apply(this, args);
		});
	await expect(client.openSession({ cwd: host.cwd, admissionId: "unanswered" })).rejects.toMatchObject({
		errorCode: "admission_storage_unavailable",
	});
	await expect(client.openSession({ cwd: host.cwd, admissionId: "unanswered" })).rejects.toMatchObject({
		errorCode: "admission_admission_unknown",
	});
	const opened = await client.openSession({ cwd: host.cwd, admissionId: "answered" });
	const retried = await client.openSession({ cwd: host.cwd, admissionId: "answered" });
	expect(retried).toMatchObject({ sessionId: opened.sessionId, admissionId: "answered" });
	const opens = requests.filter((request) => request.type === "open_session");
	expect(opens.map((request) => [request.admissionId, request.retry])).toEqual([
		["unanswered", undefined],
		["unanswered", true],
		["answered", undefined],
		["answered", true],
	]);
	expect(fixture.failures).toEqual([]);
}, 600_000);
