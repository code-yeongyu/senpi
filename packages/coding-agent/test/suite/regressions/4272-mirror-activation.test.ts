import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { CompactAdmissionError, CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";

vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs/promises");
afterEach(() => vi.restoreAllMocks());
const identity = { peer: "peer", socketEpoch: "socket-1", admissionId: "mirror", fingerprint: "a".repeat(64) };
const answer = { success: true, subscriptionId: "sub-1" };

function terminalWrite() {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let durable = false;
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		if (typeof args[1] === "string" && args[1].startsWith('{"state":"complete"')) {
			entered.resolve();
			await finish.promise;
			await actual.writeFile(...args);
			durable = true;
		} else await actual.writeFile(...args);
	});
	return { entered, finish, durable: () => durable };
}

it("T2/R93 writes the terminal outcome before synchronous exactly-once mirror activation", async () => {
	const ledger = new CompactAdmissions();
	const gate = terminalWrite();
	const activate = vi.fn(() => expect(gate.durable()).toBe(true));
	const release = vi.fn(async () => {});
	try {
		const running = ledger.run(identity, async () => ({ answer, activate, release }));
		await gate.entered.promise;
		expect(activate).not.toHaveBeenCalled();
		gate.finish.resolve();
		expect(await running).toEqual(answer);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(await ledger.run(identity, async () => expect.unreachable("retry produced again"))).toEqual(answer);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(fs.writeFile).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), {
			mode: 0o600,
			flush: true,
		});
	} finally {
		gate.finish.resolve();
		await ledger.dispose();
	}
});

it("T2/R93 a completion write failure never activates and releases exactly once", async () => {
	const ledger = new CompactAdmissions();
	const activate = vi.fn();
	const release = vi.fn(async () => {});
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		if (typeof args[1] === "string" && args[1].startsWith('{"state":"complete"'))
			throw Object.assign(new Error("full"), { code: "ENOSPC" });
		return actual.writeFile(...args);
	});
	try {
		await expect(ledger.run(identity, async () => ({ answer, activate, release }))).rejects.toMatchObject({
			reason: "storage_unavailable",
		});
		expect(activate).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		await ledger.dispose();
	}
});

it.each(["completion", "activation"] as const)(
	"T2/R93 a %s failure followed by a failed failure-row write keeps storage_unavailable",
	async (failure) => {
		const ledger = new CompactAdmissions();
		const release = vi.fn(async () => {});
		const activate = vi.fn(() => {
			if (failure === "activation") throw new Error("activation fixture cause");
		});
		const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		let failures = 0;
		vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (
				typeof args[1] === "string" &&
				failures < (failure === "completion" ? 2 : 1) &&
				(args[1].startsWith('{"state":"failed"') ||
					(failure === "completion" && args[1].startsWith('{"state":"complete"')))
			) {
				failures++;
				await actual.writeFile(args[0], "{", args[2]);
				throw Object.assign(new Error("storage fixture cause"), { code: "EIO" });
			}
			return actual.writeFile(...args);
		});
		try {
			const cause = await ledger
				.run(identity, async () => ({ answer, activate, release }))
				.catch((cause: unknown) => cause);
			expect.soft(cause).toBeInstanceOf(CompactAdmissionError);
			expect.soft(cause).toMatchObject({ reason: "storage_unavailable" });
			expect(failures).toBeGreaterThanOrEqual(failure === "completion" ? 2 : 1);
			vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
			const produce = vi.fn(async () => ({ answer, activate, release }));
			await expect(ledger.run(identity, produce)).rejects.toMatchObject({ reason: "storage_unavailable" });
			expect(await ledger.pending(identity.socketEpoch, identity.admissionId)).toBe(false);
			expect(await ledger.result(identity.socketEpoch, identity.admissionId)).toBeUndefined();
			expect(await ledger.cancel(identity.socketEpoch, identity.admissionId)).toBe("already_complete");
			expect(produce).not.toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith(expect.stringContaining("admission failure row write failed"));
		} finally {
			await ledger.dispose();
		}
	},
);

it("T2/R93 peer end during the completion write prevents activation and releases once", async () => {
	const ledger = new CompactAdmissions();
	const gate = terminalWrite();
	const activate = vi.fn();
	const release = vi.fn(async () => {});
	try {
		const running = ledger.run(identity, async () => ({ answer, activate, release }));
		await gate.entered.promise;
		ledger.endConnection("peer");
		gate.finish.resolve();
		await running;
		expect(activate).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		gate.finish.resolve();
		await ledger.dispose();
	}
});

it("T2/R93 overflow during commit persists an identical refusal on retry", async () => {
	const ledger = new CompactAdmissions();
	const gate = terminalWrite();
	const activate = vi.fn();
	const release = vi.fn(async () => {});
	const refused = { success: false, errorCode: "admission_limit", errorData: { reason: "admission_limit" } };
	let overflow = false;
	try {
		const running = ledger.run(identity, async () => ({
			answer,
			activate,
			release,
			refusal: () => (overflow ? refused : undefined),
		}));
		await gate.entered.promise;
		overflow = true;
		gate.finish.resolve();
		expect(await running).toEqual(refused);
		expect(await ledger.run(identity, async () => expect.unreachable("retry allocated again"))).toEqual(refused);
		expect(activate).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		gate.finish.resolve();
		await ledger.dispose();
	}
});

it("T2/R93 a throwing activation never exposes success to queued retry or cancel", async () => {
	const ledger = new CompactAdmissions();
	const gate = terminalWrite();
	const release = vi.fn(async () => {});
	const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const outcome = (pending: Promise<unknown>) =>
		pending.then(
			(value) => ({ value }),
			(cause: unknown) => (cause instanceof CompactAdmissionError ? { reason: cause.reason } : { cause }),
		);
	try {
		const running = outcome(
			ledger.run(identity, async () => ({
				answer,
				release,
				activate: () => {
					throw new Error("activation fixture cause");
				},
			})),
		);
		await gate.entered.promise;
		const retry = outcome(ledger.run(identity, async () => expect.unreachable("retry produced again")));
		const cancelling = ledger.cancel(identity.socketEpoch, identity.admissionId);
		const observed = ledger.result(identity.socketEpoch, identity.admissionId);
		gate.finish.resolve();
		expect.soft(await running).toEqual({ reason: "storage_unavailable" });
		expect.soft(await retry).toEqual({ reason: "storage_unavailable" });
		expect.soft(await cancelling).toBe("already_complete");
		expect.soft(await observed).toBeUndefined();
		const later = await outcome(ledger.run(identity, async () => expect.unreachable("late retry produced again")));
		expect.soft(later).toEqual({ reason: "storage_unavailable" });
		expect(release).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("activation fixture cause"));
		const rows = vi.mocked(fs.writeFile).mock.calls.map((call) => JSON.parse(String(call[1])) as { state: string });
		expect(rows.map((row) => row.state)).toEqual(["pending", "complete", "failed"]);
	} finally {
		gate.finish.resolve();
		await ledger.dispose();
	}
});

it.each(["cancel", "commit"])("T2/R93 %s wins the exact commit race without a leaked resource", async (winner) => {
	const ledger = new CompactAdmissions();
	const produced = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const activate = vi.fn();
	const release = vi.fn(async () => {});
	const write = winner === "commit" ? terminalWrite() : undefined;
	try {
		const running = ledger.run(identity, async () => {
			produced.resolve();
			await finish.promise;
			return { answer, activate, release };
		});
		await produced.promise;
		if (winner === "cancel") {
			expect(await ledger.cancel(identity.socketEpoch, identity.admissionId)).toBe("cancelled");
			finish.resolve();
			await running;
			expect(activate).not.toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(1);
			expect(await ledger.cancel(identity.socketEpoch, identity.admissionId)).toBe("cancelled");
		} else {
			finish.resolve();
			await write?.entered.promise;
			const cancelling = ledger.cancel(identity.socketEpoch, identity.admissionId);
			write?.finish.resolve();
			await running;
			expect(await cancelling).toBe("already_complete");
			expect(activate).toHaveBeenCalledTimes(1);
			expect(release).not.toHaveBeenCalled();
		}
	} finally {
		finish.resolve();
		write?.finish.resolve();
		await ledger.dispose();
	}
});
