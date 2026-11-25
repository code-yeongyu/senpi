/**
 * Whether the session an open loads stays when the opening connection ends (senpi#5808), for the open an `import`
 * asks for with `open` (senpi#6267): the same rule as `open_session`, decided when the line arrives.
 */
import { describe, expect, it } from "vitest";
import { withOpenRetention } from "./open-retention.ts";
import type { RpcCommand } from "./rpc-types.ts";

const importWith = (open: unknown): RpcCommand =>
	({ type: "move_session", op: "import", bundleDir: "/bundle", cwd: "/work", open }) as RpcCommand;

const openOf = (command: RpcCommand): unknown => ("open" in command ? command.open : undefined);

describe("withOpenRetention for the open an import asks for", () => {
	it.each<[string, unknown, unknown]>([
		["open: true", true, { retain_on_disconnect: true }],
		["open fields that do not say", { kind: "worker" }, { kind: "worker", retain_on_disconnect: true }],
		["open fields that say false", { retain_on_disconnect: false }, { retain_on_disconnect: false }],
		["open fields that say true", { retain_on_disconnect: true }, { retain_on_disconnect: true }],
	])("#given a machine-owned host and an import with %s #then the open is %j", (_case, open, expected) => {
		expect(openOf(withOpenRetention(importWith(open), false, true))).toEqual(expected);
	});

	it.each<[string, unknown, unknown]>([
		["open: true", true, { retain_on_disconnect: true }],
		["open fields that say false", { retain_on_disconnect: false }, { retain_on_disconnect: true }],
		["open fields that say true", { retain_on_disconnect: true }, { retain_on_disconnect: true }],
	])(
		"#given a delegated connection and an import with %s #then the open is %j: a forwarder keeps what it opened",
		(_case, open, expected) => {
			expect(openOf(withOpenRetention(importWith(open), true, false))).toEqual(expected);
		},
	);

	it("#given a host that is neither #then an import's open is left exactly as it was sent", () => {
		for (const open of [true, { kind: "worker" }, { retain_on_disconnect: false }])
			expect(openOf(withOpenRetention(importWith(open), false, false))).toEqual(open);
	});

	it.each([
		["no open at all", undefined],
		["an open that is neither true nor an object", "yes"],
		["an open that is a list", [true]],
	])(
		"#given a machine-owned host and an import with %s #then the record is left for the import to refuse",
		(_case, open) => {
			const command = importWith(open);
			expect(withOpenRetention(command, false, true)).toBe(command);
		},
	);

	it("#given a machine-owned host #then another op of move_session is left alone", () => {
		const status = { type: "move_session", op: "status", moveId: "move-1" } as RpcCommand;
		expect(withOpenRetention(status, false, true)).toBe(status);
	});
});
