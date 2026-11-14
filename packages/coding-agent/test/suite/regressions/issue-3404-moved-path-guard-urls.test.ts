import { describe, expect, it } from "vitest";
import { commandPaths } from "../../../src/core/extensions/builtin/moved-path-guard/command-paths.ts";

const cwd = "/work";

describe("senpi#3404 moved-path-guard does not read network URLs as paths", () => {
	it.each([
		["a bare URL with a path", "https://docs.z.ai/devpack/overview"],
		["curl with a URL", "curl -sS https://host.example/a/b"],
		["an ssh URL", "git clone ssh://git.example/org/repo"],
		["a quoted URL", 'fetch("https://host.example/a/b")'],
	])("%s yields no target", (_name, command) => {
		expect(commandPaths(command, cwd).filter((path) => path !== cwd)).toEqual([]);
	});

	it("keeps the real paths next to a URL", () => {
		expect(commandPaths("curl -o /tmp/out https://host.example/a/b", cwd)).toEqual(["/tmp/out"]);
	});

	it("keeps a file URL's local path", () => {
		expect(commandPaths("open file:///var/data/report.txt", cwd)).toContain("///var/data/report.txt");
	});
});
