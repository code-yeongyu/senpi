import { describe, expect, it } from "vitest";

import {
	loopStopAlreadyReported,
	ruleAlreadyCorrected,
} from "../../src/core/extensions/builtin/ttsr/follow-up-limit.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

const RULE = "collapse-repetition";
const correction = { type: "custom_message", customType: "ttsr-injection", details: { rules: [RULE] } };
const stop = {
	type: "custom",
	customType: "ttsr-loop-stopped",
	data: { rules: [RULE], reason: "repeated-after-correction" },
};

function entries(...items: readonly object[]): SessionEntry[] {
	return items.map((item) => ({ ...item })) as unknown as SessionEntry[];
}

describe("which turns renew the one-correction episode (senpi#4621)", () => {
	it.each([
		{
			name: "a typed user message",
			turn: { type: "message", message: { role: "user", content: "go" } },
			renews: true,
		},
		{ name: "a '.' manual continue", turn: { type: "custom_message", customType: "manual-continue" }, renews: true },
		{
			name: "a continue-from-leaf",
			turn: { type: "custom_message", customType: "continue-from-leaf" },
			renews: true,
		},
		{ name: "a person's stop-resume", turn: { type: "custom_message", customType: "session-resumed" }, renews: true },
		{
			name: "an interrupted-run recovery",
			turn: { type: "custom_message", customType: "session-resumed", details: { resumeCause: "interrupted" } },
			renews: false,
		},
		{
			name: "an engine nudge",
			turn: { type: "custom_message", customType: "ttsr-injection", details: { rules: [] } },
			renews: false,
		},
	])("$name renews it: $renews", ({ turn, renews }) => {
		expect(ruleAlreadyCorrected(entries(correction, turn), RULE)).toBe(!renews);
		expect(loopStopAlreadyReported(entries(stop, turn), RULE)).toBe(!renews);
	});
});
