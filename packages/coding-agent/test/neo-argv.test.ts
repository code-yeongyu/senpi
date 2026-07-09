import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { buildNeoArgv } from "../src/cli/neo/build-argv.ts";

/**
 * Table test: a parsed classic argv must produce the exact neo argv. Each row is
 * (classic argv → expected neo argv). The launcher forwards ALL runtime-relevant
 * flags to the Go binary; @file args and initial messages are forwarded RAW.
 */
describe("buildNeoArgv — flag passthrough", () => {
	test.each<[string, string[], string[]]>([
		["provider/model", ["--provider", "openai", "--model", "gpt-4o"], ["--provider", "openai", "--model", "gpt-4o"]],
		["models list re-joined", ["--models", "a, b ,c"], ["--models", "a,b,c"]],
		["session path", ["--session", "/p/s.jsonl"], ["--session", "/p/s.jsonl"]],
		["session-id", ["--session-id", "sess-1"], ["--session-id", "sess-1"]],
		["resume", ["--resume"], ["--resume"]],
		["continue", ["--continue"], ["--continue"]],
		["fork", ["--fork", "abc123"], ["--fork", "abc123"]],
		["thinking", ["--thinking", "high"], ["--thinking", "high"]],
		["api-key", ["--api-key", "sk-xyz"], ["--api-key", "sk-xyz"]],
		["no-session", ["--no-session"], ["--no-session"]],
		["session-dir", ["--session-dir", "/tmp/sd"], ["--session-dir", "/tmp/sd"]],
		["name", ["--name", "my session"], ["--name", "my session"]],
		["approve", ["--approve"], ["--approve"]],
		["no-approve", ["--no-approve"], ["--no-approve"]],
		["no-builtin-tools", ["--no-builtin-tools"], ["--no-builtin-tools"]],
		[
			"extensions (multiple)",
			["-e", "./a.ts", "--extension", "./b.ts"],
			["--extension", "./a.ts", "--extension", "./b.ts"],
		],
		["skill", ["--skill", "./s"], ["--skill", "./s"]],
		["prompt-template", ["--prompt-template", "./pt"], ["--prompt-template", "./pt"]],
		["theme", ["--theme", "./t.json"], ["--theme", "./t.json"]],
		["no-extensions", ["--no-extensions"], ["--no-extensions"]],
		["no-skills", ["--no-skills"], ["--no-skills"]],
		["no-prompt-templates", ["--no-prompt-templates"], ["--no-prompt-templates"]],
		["no-themes", ["--no-themes"], ["--no-themes"]],
		["no-context-files", ["--no-context-files"], ["--no-context-files"]],
		["tools", ["--tools", "read,bash"], ["--tools", "read,bash"]],
		["exclude-tools", ["--exclude-tools", "write"], ["--exclude-tools", "write"]],
		["no-tools", ["--no-tools"], ["--no-tools"]],
		["positional message", ["hello world"], ["hello world"]],
		["file arg re-prefixed with @", ["@README.md"], ["@README.md"]],
		[
			"mixed file + message (order-independent grouping)",
			["@a.md", "explain", "@img.png"],
			["explain", "@a.md", "@img.png"],
		],
	])("%s", (_label, classicArgv, expectedNeoArgv) => {
		const parsed = parseArgs(["--neo", ...classicArgv], { neoEnabled: true });
		expect(buildNeoArgv(parsed, { isolated: false })).toEqual(expectedNeoArgv);
	});

	test("isolated: true prepends --neo-isolated → --isolated for the Go binary", () => {
		const parsed = parseArgs(["--neo", "--neo-isolated", "--model", "gpt-4o"], { neoEnabled: true });
		expect(buildNeoArgv(parsed, { isolated: true })).toEqual(["--isolated", "--model", "gpt-4o"]);
	});

	test("isolated: false omits --isolated", () => {
		const parsed = parseArgs(["--neo", "--model", "gpt-4o"], { neoEnabled: true });
		expect(buildNeoArgv(parsed, { isolated: false })).toEqual(["--model", "gpt-4o"]);
	});

	test("neo-only launch (no runtime flags) → empty argv", () => {
		const parsed = parseArgs(["--neo"], { neoEnabled: true });
		expect(buildNeoArgv(parsed, { isolated: false })).toEqual([]);
	});

	test("full kitchen-sink invocation is forwarded in a stable order", () => {
		const parsed = parseArgs(
			[
				"--neo",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--thinking",
				"high",
				"--no-context-files",
				"-e",
				"./ext.ts",
				"@prompt.md",
				"Do the task",
			],
			{ neoEnabled: true },
		);
		expect(buildNeoArgv(parsed, { isolated: false })).toEqual([
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet",
			"--thinking",
			"high",
			"--extension",
			"./ext.ts",
			"--no-context-files",
			"Do the task",
			"@prompt.md",
		]);
	});
});
