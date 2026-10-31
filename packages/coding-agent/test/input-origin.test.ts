import { describe, expect, it } from "vitest";
import { customTurnOrigin, inputOriginOf } from "../src/core/input-origin.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE } from "../src/core/manual-continue.ts";

describe("input origin classification", () => {
	it.each([
		["interactive", "person"],
		["rpc", "person"],
		[undefined, "person"],
		["extension", "extension"],
	] as const)("classifies a %s input as %s", (source, origin) => {
		expect(inputOriginOf(source)).toBe(origin);
	});

	it("classifies automation turns as engine and a manual continue as a person's", () => {
		expect(customTurnOrigin("goal-continuation")).toBe("engine");
		expect(customTurnOrigin("senpi-codemode:notification")).toBe("engine");
		expect(customTurnOrigin(MANUAL_CONTINUE_CUSTOM_TYPE)).toBe("person");
	});
});
