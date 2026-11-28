/**
 * senpi#6160: every command the TUI control endpoint's `get_protocol_info` advertises is decided — either the
 * shared method-class table classifies it (so a remote relay may forward it under that class), or the terminal
 * records a deliberate exclusion with its reason (so the relay's `method_unclassified` refusal is a decision, not
 * an omission). A command added to the endpoint's list without either fails here instead of silently falling
 * through to undecided fail-closed.
 */
import { describe, expect, it } from "vitest";
import { TUI_METHOD_CLASS_EXCLUSIONS } from "../../src/modes/interactive/session-control-method-exclusions.ts";
import { TUI_CONTROL_COMMANDS } from "../../src/modes/interactive/session-control-commands.ts";
import { RPC_METHOD_CLASS } from "../../src/modes/rpc/method-classes.ts";

describe("TUI advertised command coverage (senpi#6160)", () => {
	it("classifies or deliberately excludes every command get_protocol_info lists", () => {
		const undecided = TUI_CONTROL_COMMANDS.filter(
			(command) => !Object.hasOwn(RPC_METHOD_CLASS, command) && !Object.hasOwn(TUI_METHOD_CLASS_EXCLUSIONS, command),
		);
		expect(undecided).toEqual([]);
	});

	it("keeps every exclusion honest: advertised, unclassified, reason stated", () => {
		const advertised = new Set(TUI_CONTROL_COMMANDS);
		for (const [command, reason] of Object.entries(TUI_METHOD_CLASS_EXCLUSIONS)) {
			expect(advertised.has(command), `${command} is no longer advertised; drop its exclusion`).toBe(true);
			expect(
				Object.hasOwn(RPC_METHOD_CLASS, command),
				`${command} is now classified in the table; drop its exclusion`,
			).toBe(false);
			expect(reason.trim().length > 0, `${command} states its reason`).toBe(true);
		}
	});
});
