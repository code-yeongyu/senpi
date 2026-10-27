import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";

describe("permission presets for external paths", () => {
	const cwd = "/Users/me/project";
	const registry = createBuiltinParserRegistry();
	// Targets are canonical after the spelling walk (senpi#4351), so outside paths start from a real directory.
	const outsideRoot = realpathSync.native(tmpdir());

	it("asks for external paths from direct path-taking tools under workspace preset", () => {
		// given
		const cases = [
			{ toolName: "read", input: { path: "../secret.txt" } },
			{ toolName: "write", input: { path: "/tmp/outside.txt", content: "hello" } },
			{ toolName: "grep", input: { pattern: "token", path: "/tmp" } },
			{ toolName: "ls", input: { path: "/tmp", limit: 20 } },
		];
		const ruleset = rulesForPreset("workspace");

		for (const testCase of cases) {
			// when
			const requests = registry.parse(testCase.toolName, testCase.input, cwd);
			const externalRequest = requests.find((request) => request.permission === "external_directory");

			// then
			expect(externalRequest, testCase.toolName).toBeDefined();
			expect(evaluate("external_directory", externalRequest?.patterns[0] ?? "", ruleset).action).toBe("ask");
		}
	});

	it("classifies the path the tool opens, not the raw argument (senpi#4311)", () => {
		// given: spellings the file tools resolve to the same outside file
		const outside = join(outsideRoot, "outside.txt");
		const spellings = [outside, `@${outside}`, pathToFileURL(outside).href];
		const tools = [
			{ toolName: "write", input: (path: string) => ({ path, content: "hello" }) },
			{ toolName: "edit", input: (path: string) => ({ path, edits: [] }) },
			{ toolName: "grep", input: (path: string) => ({ pattern: "token", path }) },
			{ toolName: "ls", input: (path: string) => ({ path }) },
			{ toolName: "find", input: (path: string) => ({ pattern: "*", path }) },
		];

		for (const tool of tools) {
			for (const spelling of spellings) {
				// when
				const requests = registry.parse(tool.toolName, tool.input(spelling), cwd);
				const externalRequest = requests.find((request) => request.permission === "external_directory");

				// then: the same ask as the plain path, naming the file the tool will touch, and an
				// `always` derived from it (the persisted form, string-matched on later calls)
				expect(externalRequest?.patterns, `${tool.toolName} ${spelling}`).toEqual([outside]);
				expect(externalRequest?.always, `${tool.toolName} ${spelling}`).toEqual(
					registry
						.parse(tool.toolName, tool.input(outside), cwd)
						.find((r) => r.permission === "external_directory")?.always,
				);
			}
		}
	});

	it("classifies every element of a grep path array (senpi#4311)", () => {
		// given
		const outside = join(outsideRoot, "outside");

		// when
		const only = registry.parse("grep", { pattern: "TOKEN", path: [outside] }, cwd);
		const mixed = registry.parse("grep", { pattern: "TOKEN", path: ["src", outside] }, cwd);

		// then: the outside element asks, and the grep request names the searched paths
		for (const requests of [only, mixed]) {
			expect(requests.find((r) => r.permission === "external_directory")?.patterns).toEqual([outside]);
		}
		expect(mixed.find((r) => r.permission === "grep")?.patterns).toEqual(["src", outside]);
	});

	it("classifies apply_patch body paths the way apply_patch writes them (senpi#4311)", () => {
		// given
		const outside = join(outsideRoot, "outside.txt");
		const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`;

		// when
		const absolute = registry.parse("apply_patch", { input: patch(outside) }, cwd);
		const tilde = registry.parse("apply_patch", { input: patch("~/x.txt") }, cwd);

		// then: an outside path asks; `~/x.txt` is written as `<cwd>/~/x.txt`, inside the workspace
		expect(absolute.find((r) => r.permission === "external_directory")?.patterns).toEqual([outside]);
		expect(tilde.map((r) => r.permission)).toEqual(["edit"]);
	});

	it("classifies $HOME paths by each tool's resolver: write stops asking, multiedit keeps asking (senpi#4311)", () => {
		// when: write creates a literal `$HOME` directory inside cwd; multiedit has no implementation
		const write = registry.parse("write", { path: "$HOME/x", content: "x" }, cwd);
		const multiedit = registry.parse("multiedit", { path: "$HOME/x" }, cwd);

		// then
		expect(write.map((r) => r.permission)).toEqual(["edit"]);
		expect(multiedit.map((r) => r.permission)).toContain("external_directory");
	});

	it("asks for glob paths outside the workspace in every spelling (senpi#4311)", () => {
		// given
		const outside = join(outsideRoot, "outside");

		for (const spelling of [outside, `@${outside}`, pathToFileURL(outside).href]) {
			// when
			const requests = registry.parse("glob", { pattern: "*", path: spelling }, cwd);

			// then
			expect(requests.find((r) => r.permission === "external_directory")?.patterns, spelling).toEqual([outside]);
		}
	});

	it.skipIf(process.platform === "win32")(
		"refuses a file URL the tools cannot open instead of passing it (senpi#4311)",
		() => {
			// when / then: a remote-host file URL makes the resolver throw, which blocks the call
			expect(() => registry.parse("write", { path: "file://evilhost/x", content: "x" }, cwd)).toThrow();
		},
	);

	it.runIf(process.platform === "win32")("classifies a Windows file URL as an external UNC path (senpi#4316)", () => {
		const requests = registry.parse("write", { path: "file://evilhost/x", content: "x" }, cwd);
		expect(requests.find((r) => r.permission === "external_directory")?.patterns).toEqual(["\\\\evilhost\\x\\"]);
	});
});

describe("permission presets for external paths through in-repo symlinks (senpi#4311)", () => {
	const registry = createBuiltinParserRegistry();
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	function setup(): { project: string; outsideDir: string } {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-4311-")));
		roots.push(root);
		const project = join(root, "project");
		const outsideDir = join(root, "outside");
		mkdirSync(project);
		mkdirSync(outsideDir);
		writeFileSync(join(outsideDir, "secret.txt"), "TOKEN=1");
		return { project, outsideDir };
	}

	it.skipIf(process.platform === "win32")("asks for a grep line selector on a symlink that points outside", () => {
		// given: a repository that ships `link` -> a file outside the workspace
		const { project, outsideDir } = setup();
		symlinkSync(join(outsideDir, "secret.txt"), join(project, "link"));

		// when: the tool strips `:L1-L1` when the full name does not exist and searches `link`
		const requests = registry.parse("grep", { pattern: ".", path: "link:L1-L1" }, project);

		// then
		expect(requests.map((r) => r.permission)).toContain("external_directory");
	});

	it.skipIf(process.platform === "win32")(
		"classifies only the literal selector-shaped file grep opens (senpi#4316)",
		async () => {
			const { project, outsideDir } = setup();
			symlinkSync(join(outsideDir, "secret.txt"), join(project, "link"));
			const literal = join(project, "link:L1-L1");
			writeFileSync(literal, "TOKEN=literal\n");
			const input = { pattern: "TOKEN", path: "link:L1-L1" };

			const result = await createGrepToolDefinition(project).execute("literal", input, undefined, undefined, {
				cwd: project,
			} as ExtensionToolContext);
			expect(result.details?.paths).toEqual([literal]);
			expect(result.details?.matches.map((match) => match.text)).toEqual(["TOKEN=literal"]);
			expect(registry.parse("grep", input, project).map((r) => r.permission)).toEqual(["grep"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not classify a directory prefix as a grep line-selector target (senpi#4316)",
		async () => {
			const { project, outsideDir } = setup();
			symlinkSync(outsideDir, join(project, "link"));
			const input = { pattern: "TOKEN", path: "link:L1-L1" };

			await expect(
				createGrepToolDefinition(project).execute("directory", input, undefined, undefined, {
					cwd: project,
				} as ExtensionToolContext),
			).rejects.toThrow("Path not found:");
			expect(registry.parse("grep", input, project).map((r) => r.permission)).toEqual(["grep"]);
		},
	);

	it.skipIf(process.platform === "win32")("asks for a Unicode-space spelling of a symlinked outside directory", () => {
		// given: `a b` (plain space) links outside; the model writes `a\u00A0b`, which the tool normalizes
		const { project, outsideDir } = setup();
		symlinkSync(outsideDir, join(project, "a b"));

		// when
		const requests = registry.parse("write", { path: "a\u00A0b/secret.txt", content: "x" }, project);

		// then
		expect(requests.map((r) => r.permission)).toContain("external_directory");
	});
});

describe("permission presets for external paths (continued)", () => {
	const cwd = "/Users/me/project";
	const registry = createBuiltinParserRegistry();

	it("keeps an @-prefixed path inside the workspace internal (senpi#4311)", () => {
		// when
		const requests = registry.parse("write", { path: "@src/a.ts", content: "x" }, cwd);

		// then
		expect(requests.map((request) => request.permission)).toEqual(["edit"]);
	});

	it("does not broaden root-level external path approvals to the filesystem root", () => {
		// given
		const temp = realpathSync.native(tmpdir());
		const root = parse(temp).root;
		const cases = [
			{ toolName: "ls", input: { path: temp }, always: [`${temp}/*`] },
			{ toolName: "read", input: { path: join(temp, "file.txt") }, always: [`${temp}/*`] },
			{ toolName: "read", input: { path: join(root, "secret.txt") }, always: [join(root, "secret.txt")] },
			{ toolName: "read", input: { path: join(root, "secret") }, always: [join(root, "secret")] },
		];

		for (const testCase of cases) {
			// when
			const requests = registry.parse(testCase.toolName, testCase.input, cwd);
			const externalRequest = requests.find((request) => request.permission === "external_directory");

			// then
			expect(externalRequest?.always, testCase.toolName).toEqual(testCase.always);
		}
	});
});
