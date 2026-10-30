import * as os from "node:os";
import { describe, expect, test } from "vitest";
import { hostLine, pinnedDisplayPath } from "../src/extension/host-facts.ts";

const PIN = JSON.stringify({ cpuModel: "Synthetic CPU", cores: 997, kernel: "Synthetic 0.0.0" });

describe("hostLine SENPI_TEST_WORKSTATION pin", () => {
	test("unset or empty: the real CPU model and core count", () => {
		const real = ` \u00b7 ${os.availableParallelism()} cores \u00b7 `;
		expect(hostLine({})).toContain(real);
		expect(hostLine({ SENPI_TEST_WORKSTATION: "" })).toBe(hostLine({}));
	});

	test("set: the pinned CPU model and core count replace the real ones", () => {
		const line = hostLine({ SENPI_TEST_WORKSTATION: PIN });
		expect(line.startsWith(`${os.platform()} ${os.arch()} \u00b7 Synthetic CPU \u00b7 997 cores \u00b7 `)).toBe(true);
		expect(line).toBe(
			hostLine({}).replace(/ \u00b7 .* \u00b7 \d+ cores \u00b7 /, " \u00b7 Synthetic CPU \u00b7 997 cores \u00b7 "),
		);
	});

	test.each([
		"not json",
		"[]",
		JSON.stringify({ cpuModel: "x", cores: 2 }),
		JSON.stringify({ cpuModel: "", cores: 2, kernel: "k" }),
		JSON.stringify({ cpuModel: "x", cores: 0, kernel: "k" }),
		JSON.stringify({ cpuModel: "x", cores: 2.5, kernel: "k" }),
		JSON.stringify({ cpuModel: "x", cores: 2, kernel: "k", extra: 1 }),
	])("an invalid pin %s throws an error naming the variable", (value) => {
		expect(() => hostLine({ SENPI_TEST_WORKSTATION: value })).toThrow(/SENPI_TEST_WORKSTATION must be a JSON object/);
	});
});

// senpi#5067: the optional repoRoot pin shows a path under the pinned checkout under a synthetic root (rendering only).
describe("pinnedDisplayPath SENPI_TEST_WORKSTATION repoRoot", () => {
	const HOST = { cpuModel: "Synthetic CPU", cores: 997, kernel: "Synthetic 0.0.0" };
	const REPO_PIN = JSON.stringify({ ...HOST, repoRoot: { from: "/work/checkout", to: "/eq-synthetic/checkout" } });
	const skill = "/work/checkout/packages/senpi-codemode/src/skill/bun-1-4/SKILL.md";

	test("unset, empty, or a pin without repoRoot: the path is unchanged", () => {
		expect(pinnedDisplayPath(skill, {})).toBe(skill);
		expect(pinnedDisplayPath(skill, { SENPI_TEST_WORKSTATION: "" })).toBe(skill);
		expect(pinnedDisplayPath(skill, { SENPI_TEST_WORKSTATION: PIN })).toBe(skill);
	});

	test("a path under from is shown under to; a path outside it, even sharing its prefix, is unchanged", () => {
		const env = { SENPI_TEST_WORKSTATION: REPO_PIN };
		expect(pinnedDisplayPath(skill, env)).toBe(
			"/eq-synthetic/checkout/packages/senpi-codemode/src/skill/bun-1-4/SKILL.md",
		);
		expect(pinnedDisplayPath("/work/checkout", env)).toBe("/eq-synthetic/checkout");
		expect(pinnedDisplayPath("/work/checkout-2/SKILL.md", env)).toBe("/work/checkout-2/SKILL.md");
	});

	test("the host line still honors the CPU pin alongside repoRoot", () => {
		expect(hostLine({ SENPI_TEST_WORKSTATION: REPO_PIN })).toBe(hostLine({ SENPI_TEST_WORKSTATION: PIN }));
	});

	test.each([
		JSON.stringify({ ...HOST, repoRoot: "/work/checkout" }),
		JSON.stringify({ ...HOST, repoRoot: { from: "work/checkout", to: "/eq" } }),
		JSON.stringify({ ...HOST, repoRoot: { from: "/work/checkout" } }),
		JSON.stringify({ ...HOST, repoRoot: { from: "/work/checkout", to: "/eq", extra: 1 } }),
	])("malformed repoRoot %s throws naming the variable", (value) => {
		expect(() => pinnedDisplayPath(skill, { SENPI_TEST_WORKSTATION: value })).toThrow(
			/SENPI_TEST_WORKSTATION must be a JSON object/,
		);
		expect(() => hostLine({ SENPI_TEST_WORKSTATION: value })).toThrow(/SENPI_TEST_WORKSTATION must be a JSON object/);
	});
});
