import { describe, expect, it } from "vitest";
// The REAL permission-system rule parser and evaluator (the tool_call hook's path), not a copy.
import { parsePermissionFlag } from "../../coding-agent/src/core/extensions/builtin/permission-system/cli.ts";
import { rulesForPreset } from "../../coding-agent/src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../coding-agent/src/core/extensions/builtin/permission-system/evaluate.ts";
import { computerPermissionParser } from "../src/permission.ts";

const windowStep = { method: "window", args: [{ app: "Code" }] };

function patternsOf(input: Record<string, unknown>): readonly string[] {
	return computerPermissionParser("computer", input, "/work").flatMap((request) => request.patterns);
}

/** What the permission-system decides for `input` under `flag` layered over the default preset. */
function decide(flag: string, input: Record<string, unknown>): readonly string[] {
	const rules = [...rulesForPreset("full-access"), ...parsePermissionFlag(flag)];
	return computerPermissionParser("computer", input, "/work").flatMap((request) =>
		request.patterns.map((pattern) => evaluate(request.permission, pattern, rules).action),
	);
}

describe("computerPermissionParser tiers", () => {
	it("classifies window->screenshot as read", () => {
		// Given
		const input = { action: "call", chain: [windowStep, { method: "screenshot" }] };

		// When
		const patterns = patternsOf(input);

		// Then
		expect(patterns).toEqual(["read"]);
	});

	it("classifies window->click as exec", () => {
		// Given
		const input = { action: "call", chain: [windowStep, { method: "click", args: [1, 2] }] };

		// When
		const patterns = patternsOf(input);

		// Then
		expect(patterns).toEqual(["exec"]);
	});

	it("classifies run without read_only as exec", () => {
		// Given
		const input = { action: "run", code: "return 1" };

		// When
		const patterns = patternsOf(input);

		// Then
		expect(patterns).toEqual(["exec"]);
	});

	it("classifies run with read_only true as read", () => {
		// Given
		const input = { action: "run", code: "return 1", read_only: true };

		// When
		const patterns = patternsOf(input);

		// Then
		expect(patterns).toEqual(["read"]);
	});

	it("classifies capabilities as read", () => {
		// Given
		const input = { action: "capabilities" };

		// When
		const patterns = patternsOf(input);

		// Then
		expect(patterns).toEqual(["read"]);
	});

	it.each([
		["an unknown root method", [{ method: "userReset" }]],
		["an unknown handle method", [windowStep, { method: "userReset" }]],
		["a three-step chain of reads", [windowStep, { method: "ref", args: ["e1"] }, { method: "value" }]],
		["an unchainable root", [{ method: "windows" }, { method: "screenshot" }]],
		["a non-object step", [null]],
		["a missing chain", undefined],
	])("never classifies %s as read", (_label, chain) => {
		// Given
		const input = { action: "call", chain };

		// When
		const patterns = patternsOf(input);

		// Then
		expect(patterns).toEqual(["exec"]);
	});

	it("names the computer permission and scopes an always-approval to the requested tier", () => {
		// Given
		const input = { action: "call", chain: [{ method: "screenshot" }] };

		// When
		const requests = computerPermissionParser("computer", input, "/work");

		// Then
		expect(requests).toEqual([{ permission: "computer", patterns: ["read"], always: ["read"] }]);
	});
});

describe("computerPermissionParser through the real permission-system evaluate()", () => {
	const click = { action: "call", chain: [windowStep, { method: "click", args: [1, 2] }] };
	const screenshot = { action: "call", chain: [windowStep, { method: "screenshot" }] };

	it("denies an exec chain under computer:exec=deny", () => {
		// Given: the rule set a `--permission computer:exec=deny,computer:read=allow` session evaluates.
		const flag = "computer:exec=deny,computer:read=allow";

		// When
		const actions = decide(flag, click);

		// Then
		expect(actions).toEqual(["deny"]);
	});

	it("lets a screenshot chain through under computer:read=allow while exec is denied", () => {
		// Given
		const flag = "computer:exec=deny,computer:read=allow";

		// When
		const actions = decide(flag, screenshot);

		// Then
		expect(actions).toEqual(["allow"]);
	});

	it("asks for both tiers under a bare computer=ask rule", () => {
		// Given
		const flag = "computer=ask";

		// When
		const actions = [...decide(flag, click), ...decide(flag, screenshot)];

		// Then
		expect(actions).toEqual(["ask", "ask"]);
	});
});
