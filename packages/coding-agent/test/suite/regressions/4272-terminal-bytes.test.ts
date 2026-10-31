import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	carryRecovery,
	recoveryCarrier,
	SessionRecoveryIdentity,
} from "../../../src/core/session-recovery-identity.ts";

afterEach(() => vi.unstubAllEnvs());

// Part of #4272, R24.1: exact pre-carrier JSON grammar, not just absence of a named property.
for (const enabled of [false, true]) {
	it(`R24.1 C2.4 legacy event and transcript bytes retain their grammar with flag ${enabled ? "ON" : "OFF"}`, async () => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", enabled ? "1" : "0");
		const dir = await mkdtemp(join(tmpdir(), "s05-bytes-"));
		const manager = SessionManager.create(dir, dir);
		try {
			await manager.persistHeaderNow();
			manager.beginTranscriptJournal();
			const message = { role: "user" as const, content: "payload", timestamp: 1 };
			const event = { type: "message_end", message };
			if (enabled) new SessionRecoveryIdentity().observe(event);
			const carrier = recoveryCarrier(event);
			const copy = carryRecovery(event, { ...event });
			expect(JSON.stringify(copy)).toBe(
				'{"type":"message_end","message":{"role":"user","content":"payload","timestamp":1}}',
			);
			expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
			const id = manager.appendOwnedMessage(message, { recoveryOwner: carrier });
			const entry = manager.getEntry(id);
			if (!entry) throw new Error("missing committed entry");
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing transcript");
			const bytes = await readFile(file, "utf8");
			expect(bytes.split("\n").at(-2)).toBe(
				JSON.stringify({
					type: "message",
					id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					message,
				}),
			);
			const transitions = manager.drainTranscript();
			const append = transitions.find((transition) => transition.kind === "append");
			expect(append?.kind === "append" ? append.owningMessageId : undefined).toBe(carrier?.messageId);
			if (carrier) expect(bytes).not.toContain(carrier.epoch);
		} finally {
			manager.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});
}
