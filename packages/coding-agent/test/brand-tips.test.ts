import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { APP_NAME, agentDirLabel, CONFIG_DIR_NAME } from "../src/config.ts";

const CATALOG_URL = new URL("../src/modes/interactive/tips/catalog/", import.meta.url);
const HELP_URL = new URL("../src/core/extensions/builtin/help/index.ts", import.meta.url);

function catalogSources(): Array<{ file: string; source: string }> {
	return readdirSync(CATALOG_URL)
		.filter((file) => file.endsWith("-tips.ts"))
		.map((file) => ({ file, source: readFileSync(new URL(file, CATALOG_URL), "utf-8") }));
}

describe("tips and help text", () => {
	test("no catalog file hardcodes the product name or its config directory", () => {
		for (const { file, source } of catalogSources()) {
			expect({ file, hit: /\bsenpi\b/i.test(source) }).toEqual({ file, hit: false });
		}
	});

	test("help text names the running product instead of a fixed brand", () => {
		expect(/\bsenpi\b/i.test(readFileSync(HELP_URL, "utf-8"))).toBe(false);
	});

	test("a standalone install still reads as senpi", () => {
		expect(APP_NAME).toBe("senpi");
		expect(CONFIG_DIR_NAME).toBe(".senpi");
		expect(agentDirLabel()).toBe("~/.senpi/agent");
	});
});
