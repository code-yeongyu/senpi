import { afterEach, expect, it, vi } from "vitest";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => vi.unstubAllEnvs());

const SETTLED = 1_000;

// senpi#4460 RULING-48 item 9: measures what one settled message keeps resident, with the real id generators
// (randomUUID message ids, 8-hex entry ids): exactly `settled:<message>` -> entry id and `entry:<entry>` -> "". The
// id payload per message is constant, so the totals at 10k and 100k settled messages are that payload times the count.
it("item 9 residency: each settled message keeps two id keys of constant size, so totals are linear in message count", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const joins: { messageId: string; entryId: string }[] = [];
		for (let index = 0; index < SETTLED; index++) {
			const content = `m${index}`;
			const { carrier } = rig.end("user", content);
			rig.manager.appendOwnedMessage({ role: "user", content, timestamp: 1 }, { recoveryOwner: carrier });
			const [append] = rig.manager.drainTranscript();
			if (append?.kind !== "append") throw new Error("no owned append");
			rig.lane.applyTranscript([append]);
			joins.push({ messageId: carrier.messageId, entryId: append.id });
		}
		expect(rig.diagnostics).toEqual([]);
		const keys: Map<string, string> = Reflect.get(Reflect.get(rig.lane, "settled"), "keys");
		expect(keys.size).toBe(2 * SETTLED);
		const perMessage = new Set(
			joins.map(({ messageId, entryId }) => {
				expect(keys.get(`settled:${messageId}`)).toBe(entryId);
				expect(keys.get(`entry:${entryId}`)).toBe("");
				expect([messageId.length, entryId.length]).toEqual([36, 8]);
				return `settled:${messageId}`.length + entryId.length + `entry:${entryId}`.length;
			}),
		);
		expect([...perMessage], "id code units resident per settled message (one byte each, ASCII)").toEqual([66]);
	} finally {
		await rig.close();
	}
});
