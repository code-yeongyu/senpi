/**
 * The engine-forwarded commands' observable surface - stdout, stderr and exit code - pinned from the
 * real CLI as a subprocess. The snapshot was recorded before these commands became renderers over the
 * exported engine functions (senpi#7450), so it is the "before" side of that change's parity proof:
 * a command whose output or exit code moved fails here.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";

const PACKAGE_ROOT = join(__dirname, "..", "..");
const CLI = join(PACKAGE_ROOT, "src", "cli.ts");
const FIXTURE_SESSION = join(PACKAGE_ROOT, "test", "fixtures", "before-compaction.jsonl");

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

let root: string;
let agentDir: string;
let projectDir: string;
let packageDir: string;

function normalize(text: string): string {
	let normalized = text;
	for (const prefix of [realpathSync(root), root]) normalized = normalized.replaceAll(prefix, "<TMP>");
	return normalized;
}

function cli(...args: string[]): Run {
	const result = spawnSync("bun", [CLI, ...args], {
		cwd: projectDir,
		encoding: "utf8",
		timeout: 120_000,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			TMPDIR: join(root, "tmp"),
			SENPI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			NO_COLOR: "1",
		},
	});
	return { status: result.status, stdout: normalize(result.stdout), stderr: normalize(result.stderr) };
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "engine-cli-goldens-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	packageDir = join(root, "local-package");
	for (const dir of [agentDir, projectDir, packageDir, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

interface GoldenCase {
	readonly name: string;
	readonly args: () => readonly string[];
	/** Runs before the command; its returned cleanup runs after it. */
	readonly arrange?: () => () => void;
	/** Pins only the record's status, stderr and top-level keys (its byte counts move with every prompt edit). */
	readonly shapeOnly?: boolean;
}

function withProjectPackage(): () => void {
	mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(projectDir, CONFIG_DIR_NAME, "settings.json"),
		JSON.stringify({ packages: ["npm:@project/pkg"] }),
	);
	return () => rmSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true, force: true });
}

function withSessionCopy(): () => void {
	copyFileSync(FIXTURE_SESSION, join(root, "session.jsonl"));
	return () => {};
}

const GROUPS: Readonly<Record<string, readonly GoldenCase[]>> = {
	packages: [
		{ name: "list empty", args: () => ["list"] },
		{ name: "install missing source", args: () => ["install"] },
		{ name: "install unknown option", args: () => ["install", "--bogus", packageDir] },
		{ name: "install unexpected argument", args: () => ["install", packageDir, "extra"] },
		{ name: "install local untrusted", args: () => ["install", "-l", packageDir, "--no-approve"] },
		{ name: "install local path", args: () => ["install", packageDir] },
		{ name: "list one user package", args: () => ["list"] },
		{ name: "update one package by flag", args: () => ["update", "--extension", packageDir] },
		{ name: "update one package positional", args: () => ["update", packageDir] },
		{ name: "update every package", args: () => ["update", "--extensions"] },
		{ name: "update extension missing value", args: () => ["update", "--extension"] },
		{ name: "update models conflict", args: () => ["update", "--models", "--self"] },
		{ name: "remove installed", args: () => ["remove", packageDir] },
		{ name: "uninstall not installed", args: () => ["uninstall", packageDir] },
		{ name: "list rejects local", args: () => ["list", "--local"] },
		{ name: "list approved project package", args: () => ["list", "--approve"], arrange: withProjectPackage },
		{ name: "list unapproved project package", args: () => ["list", "--no-approve"], arrange: withProjectPackage },
	],
	config: [
		{ name: "agent-dir", args: () => ["config", "agent-dir", "--json"] },
		{ name: "agent-dir without json", args: () => ["config", "agent-dir"] },
		{ name: "config unknown option", args: () => ["config", "--bogus"] },
		{ name: "config unexpected argument", args: () => ["config", "extra"] },
		{ name: "config local untrusted", args: () => ["config", "-l", "--no-approve"] },
	],
	schedule: [
		{ name: "list text", args: () => ["schedule", "list"] },
		{ name: "list json", args: () => ["schedule", "list", "--json"] },
		{ name: "list unknown option", args: () => ["schedule", "list", "--bogus"] },
		{ name: "cancel missing id", args: () => ["schedule", "cancel"] },
		{ name: "cancel two ids", args: () => ["schedule", "cancel", "a", "b"] },
		{ name: "cancel unknown id", args: () => ["schedule", "cancel", "no-such-job"] },
		{ name: "run once nothing due", args: () => ["schedule", "run"] },
		{ name: "run bad concurrency", args: () => ["schedule", "run", "--concurrency", "0"] },
		{ name: "run exec missing command", args: () => ["schedule", "run", "--exec"] },
		{ name: "missing subcommand", args: () => ["schedule"] },
	],
	models: [
		{ name: "discover missing provider", args: () => ["models", "discover"] },
		{ name: "discover extra argument", args: () => ["models", "discover", "a", "b"] },
		{ name: "discover unknown provider", args: () => ["models", "discover", "no-such-provider"] },
		{ name: "list-models no match", args: () => ["--list-models", "zzzz-no-such-model"] },
	],
	queries: [
		{ name: "session-of-pid invalid", args: () => ["session-of-pid", "abc", "--json"] },
		{ name: "session-of-pid without json", args: () => ["session-of-pid", "1"] },
		{
			name: "export to path",
			args: () => ["--export", join(root, "session.jsonl"), join(root, "out.html")],
			arrange: withSessionCopy,
		},
		{ name: "export missing file", args: () => ["--export", join(root, "missing.jsonl")] },
		{ name: "prompt sizes record shape", args: () => ["--print-prompt-sizes"], shapeOnly: true },
	],
	host: [
		{ name: "shard-path json", args: () => ["host", "shard-path", "--kind", "p", "--owner", "x", "--json"] },
		{ name: "shard-path bare", args: () => ["host", "shard-path", "--kind", "i", "--owner", "x"] },
		{ name: "shard-path missing owner", args: () => ["host", "shard-path", "--kind", "p"] },
		{ name: "gc empty", args: () => ["host", "gc", "--json"] },
		{ name: "status no host", args: () => ["host", "status", "--json"] },
		{ name: "stop wait without drain", args: () => ["host", "stop", "--wait-ms", "5"] },
		{ name: "unknown subcommand", args: () => ["host", "frobnicate"] },
	],
};

function observed(run: Run, shapeOnly: boolean): unknown {
	if (!shapeOnly) return run;
	const record: unknown = JSON.parse(run.stdout);
	return {
		status: run.status,
		stderr: run.stderr,
		keys: typeof record === "object" && record !== null ? Object.keys(record) : [],
	};
}

describe("engine-forwarded command output (senpi#7450 parity baseline)", () => {
	for (const [group, cases] of Object.entries(GROUPS)) {
		describe(group, () => {
			for (const golden of cases) {
				it(golden.name, () => {
					const cleanup = golden.arrange?.() ?? (() => {});
					try {
						expect(observed(cli(...golden.args()), golden.shapeOnly === true)).toMatchSnapshot();
					} finally {
						cleanup();
					}
				});
			}
		});
	}
});
