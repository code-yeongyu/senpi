import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => vi.unstubAllEnvs());

// Part of #4272: C2.1-C2.4, ruling 12 Q3/Q4/Q7.
for (const order of ["end-append", "append-end"] as const) {
	it(`T1 C2.1 C2.2 Q3 ${order}: every cut has exactly one terminal representation`, async () => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const rig = await settledRig();
		try {
			const message = { role: "user" as const, content: "frozen payload", timestamp: 1 };
			const start = { type: "message_start", message };
			rig.producer.observe(start);
			const owner = recoveryCarrier(start);
			if (!owner) throw new Error("missing owner");
			rig.lane.accept(start, owner);
			const end = () => {
				const record = { type: "message_end", message };
				rig.producer.observe(record);
				rig.lane.accept(record, recoveryCarrier(record));
			};
			const append = () => {
				rig.manager.appendOwnedMessage(message, { recoveryOwner: owner });
				rig.lane.applyTranscript(rig.manager.drainTranscript());
			};
			const operations = order === "end-append" ? [end, append] : [append, end];
			const held = [];
			for (const operation of operations) {
				operation();
				const cut = await rig.cut();
				held.push(cut);
				const history = readTranscriptRoot(cut.root.transcript);
				expect(history.ok).toBe(true);
				const entries = history.ok ? history.entries.filter((entry) => entry.type === "message") : [];
				expect(cut.settledMessages.length + entries.length).toBe(1);
				if (cut.settledMessages.length)
					expect(cut.settledMessages[0]).toMatchObject({
						messageId: owner.messageId,
						entryId: null,
						status: "pending",
						terminal: message,
						runtimeItemKey: null,
					});
				else expect(cut.owners[0]).toMatchObject({ messageId: owner.messageId, entryId: entries[0]?.id });
			}
			message.content = "mutated after acceptance";
			expect(await rig.lane.readSettled(held[0].root)).toEqual({
				settledMessages: held[0].settledMessages,
				owners: held[0].owners,
			});
			expect(held[1].settledMessages).toEqual([]);
		} finally {
			await rig.close();
		}
	});
}

it("T1 C2.3 C2.4 failure preserves the held pending cut and fresh reads replay no effects", async () => {
	const rig = await settledRig();
	try {
		const { carrier } = rig.end("assistant");
		const pending = await rig.cut();
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "EACCES denied" }, carrier);
		const failed = await rig.cut();
		expect(failed.settledMessages[0]).toMatchObject({
			status: "failed",
			error: { errorMessage: "EACCES denied" },
			terminalSequence: pending.settledMessages[0]?.terminalSequence,
		});
		for (const type of ["turn_end", "agent_end", "compaction_end", "context_edited"])
			rig.lane.accept({ type }, undefined);
		rig.lane.applyTranscript([{ kind: "leaf", leafId: null }]);
		rig.end("user", "later message");
		const beforeRead = rig.lane.freeze();
		const persist = vi.spyOn(rig.manager, "_persist");
		for (let i = 0; i < 3; i++) {
			expect((await rig.lane.readSettled(pending.root)).settledMessages[0]?.status).toBe("pending");
			expect((await rig.cut()).settledMessages.find((row) => row.messageId === carrier.messageId)).toEqual(
				failed.settledMessages[0],
			);
		}
		expect(rig.lane.freeze().sequence).toBe(beforeRead.sequence);
		expect(persist).not.toHaveBeenCalled();
	} finally {
		await rig.close();
	}
});

for (const role of ["user", "assistant", "toolResult", "custom", "futureRole"]) {
	it(`C2.1 Q4 retains the full ${role} terminal without inventing durability`, async () => {
		const rig = await settledRig();
		try {
			const { carrier } = rig.end(role);
			const cut = await rig.cut();
			expect(cut.settledMessages[0]).toMatchObject({
				messageId: carrier.messageId,
				role,
				status: "pending",
				entryId: null,
			});
			expect(cut.owners).toEqual([]);
			expect(rig.diagnostics).toEqual(role === "futureRole" ? ["unsupported_role"] : []);
		} finally {
			await rig.close();
		}
	});
}

it("C2.2 Q3 durableEntryId joins an existing base entry before the terminal", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const id = rig.manager.appendCustomMessageEntry("notice", "existing", true);
		rig.lane.applyTranscript(rig.manager.drainTranscript());
		const event = { type: "message_end", message: { role: "custom", content: "existing" } };
		rig.producer.observe(event);
		rig.producer.hint?.(event, id);
		rig.lane.accept(event, recoveryCarrier(event));
		const cut = await rig.cut();
		expect(cut.settledMessages).toEqual([]);
		expect(cut.owners[0]?.entryId).toBe(id);
	} finally {
		await rig.close();
	}
});

for (const invalid of ["duplicate end", "unknown end", "retired append"] as const) {
	it(`Q7 C2.3 ${invalid} is diagnostic-only and leaves settled state unchanged`, async () => {
		const rig = await settledRig();
		try {
			const { record, carrier } = rig.end();
			const before = await rig.cut();
			if (invalid === "retired append")
				rig.lane.applyTranscript([
					{
						kind: "append",
						id: "foreign-entry",
						entry: "{}",
						owningMessageId: carrier.messageId,
						recoveryEpoch: "retired",
					},
				]);
			else rig.lane.accept(record, invalid === "duplicate end" ? carrier : undefined);
			const after = await rig.cut();
			expect(after.settledMessages).toEqual(before.settledMessages);
			expect(after.owners).toEqual(before.owners);
			expect(rig.diagnostics).toEqual([
				invalid === "duplicate end"
					? "duplicate_end"
					: invalid === "unknown end"
						? "unknown_message"
						: "retired_owner",
			]);
			expect(rig.lane.retired).toBe(false);
		} finally {
			await rig.close();
		}
	});
}

it("C2.2 Q6 a later owned append joins a failed row and releases its payload", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const { carrier } = rig.end();
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "denied" }, carrier);
		rig.manager.appendOwnedMessage({ role: "user", content: "terminal", timestamp: 1 }, { recoveryOwner: carrier });
		rig.lane.applyTranscript(rig.manager.drainTranscript());
		const cut = await rig.cut();
		expect(cut.settledMessages).toEqual([]);
		expect(cut.owners).toHaveLength(1);
		expect(rig.lane.storageStatus().residentPayloadBytes).toBe(0);
	} finally {
		await rig.close();
	}
});
