import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { getNativeGrepCandidatePaths } from "../../src/core/tools/grep/native-loader.ts";
import { resolveGrepEngine } from "../../src/core/tools/grep/select-engine.ts";
import { describeEngineContract } from "./engine-contract.ts";

const hasAddon = Boolean(process.env.SENPI_GREP_NATIVE_PATH) || getNativeGrepCandidatePaths().some(existsSync);

if (hasAddon) {
	describeEngineContract("native", () => resolveGrepEngine({ env: { ...process.env, SENPI_GREP_ENGINE: "native" } }));
} else {
	it("requires a native fixture when the native contract is explicitly requested", () => {
		expect(process.env.SENPI_GREP_ENGINE).not.toBe("native");
	});
}
