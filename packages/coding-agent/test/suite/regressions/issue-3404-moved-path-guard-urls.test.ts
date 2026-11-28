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

	// Review of #5533: a URL token is classified as a whole; a quoted query keeps its separators, so no
	// `//host/share` tail of a query value is left behind to be probed as a path.
	it.each([
		["a quoted query with &", 'curl "https://host.example/a?x=1&next=//other.example/share"'],
		["a quoted query with ;", "curl 'https://host.example/a?x=1;y=/b/c'"],
		["a URL holding a comma", "curl https://host.example/a,b/c"],
	])("%s is one URL token and yields no target", (_name, command) => {
		expect(commandPaths(command, cwd).filter((path) => path !== cwd)).toEqual([]);
	});

	it.each([
		["a brace alternative", "cp {https://host.example/a,/old/project/file} dest"],
		["a comma-joined local path", "fetch-all https://host.example/a,/old/project/file"],
		["a path after a quoted URL", 'note "see https://host.example/a /old/project/file"'],
	])("%s keeps the local operand next to the URL", (_name, command) => {
		expect(commandPaths(command, cwd)).toContain("/old/project/file");
	});

	it("keeps a file URL's local path", () => {
		expect(commandPaths("open file:///var/data/report.txt", cwd)).toContain("///var/data/report.txt");
	});
});
