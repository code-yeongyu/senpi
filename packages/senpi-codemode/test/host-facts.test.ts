import * as os from "node:os";
import { describe, expect, test } from "vitest";
import { hostLine } from "../src/extension/host-facts.ts";

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
