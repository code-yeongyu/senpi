import { expect, it } from "vitest";
import { EngineTurnHold } from "../../../src/core/engine-turn-hold.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3853: persistence failures must leave the live owner usable and retain payload custody.
it("keeps an unattended hold and its wake when persistence fails", () => {
	const notices: string[] = [];
	const ledger = new EngineTurnHold(
		[],
		true,
		() => {
			throw new Error("disk full");
		},
		(message) => notices.push(message),
		() => {},
	);
	expect(() => ledger.start()).not.toThrow();
	expect(() =>
		ledger.note("monitor", {
			role: "custom",
			customType: "senpi-monitor:event",
			content: "event",
			display: false,
			timestamp: 1,
		}),
	).not.toThrow();
	expect(ledger.messages()).toHaveLength(1);
	expect(ledger.noticeCount).toBe(1);
	expect(notices.length).toBeGreaterThan(0);
});

it("persists one consumption transition per entry and ignores repeated acknowledgements", () => {
	const manager = SessionManager.inMemory();
	const ledger = new EngineTurnHold(
		[],
		true,
		(type, data) => {
			manager.appendCustomEntry(type, data);
		},
		() => {},
		() => {},
	);
	ledger.start();
	ledger.note("codemode", {
		role: "custom",
		customType: "senpi-codemode:notification",
		content: "event",
		display: false,
		timestamp: 1,
	});
	const [snapshot] = ledger.messages();
	if (!snapshot) throw new Error("missing snapshot");
	ledger.consume(snapshot.source, snapshot.noticeIds);
	ledger.consume(snapshot.source, snapshot.noticeIds);
	expect(
		manager.getEntries().filter((e) => e.type === "custom" && e.customType === "session-notices-consumed"),
	).toHaveLength(1);
	const replay = new EngineTurnHold(
		manager.getEntries(),
		false,
		() => {},
		() => {},
		() => {},
	);
	expect(replay.messages()).toEqual([]);
});
