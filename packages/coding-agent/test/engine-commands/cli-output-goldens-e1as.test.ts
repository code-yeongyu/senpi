/**
 * The CLI paths slice E1a-s moved onto shared cores (senpi#7451) - `auth check` and the print commands, the
 * session-flag refusals, `--list-models` with launch setup flags - pinned from the real CLI as a subprocess. The
 * snapshot was recorded at E1a's head, before any E1a-s source change, so it is the "before" side of this slice's
 * no-behaviour-change proof: a command whose stdout, stderr or exit code moved fails here.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");
const SYNTHETIC_KEY = "sk-golden-synthetic-e1as";

let root: string;
let agentDir: string;
let projectDir: string;

function normalize(text: string): string {
	let normalized = text;
	for (const prefix of [realpathSync(root), root]) normalized = normalized.replaceAll(prefix, "<TMP>");
	return normalized;
}

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
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

function withAuth(credentials: Record<string, unknown>): () => () => void {
	return () => {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
		return () => rmSync(join(agentDir, "auth.json"), { force: true });
	};
}

const STORED_KEY = withAuth({ openai: { type: "api_key", key: SYNTHETIC_KEY } });
const STORED_CLI_ACCOUNT = withAuth({
	"anthropic-subscription": {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		accounts: [
			{
				name: "work",
				source: "login",
				store: "claude-cli",
				dirId: "c".repeat(32),
				check: {
					model: "claude-model",
					outcome: "failed",
					reason: "rate_limit",
					message: "limit",
					status: 429,
					at: 1,
				},
			},
		],
	},
});

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "engine-cli-goldens-e1as-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	for (const dir of [agentDir, projectDir, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

interface GoldenCase {
	readonly name: string;
	readonly args: readonly string[];
	readonly arrange?: () => () => void;
}

const GROUPS: Readonly<Record<string, readonly GoldenCase[]>> = {
	auth: [
		{ name: "check without a target", args: ["auth", "check"] },
		{
			name: "check unknown provider json",
			args: ["auth", "check", "--provider", "no-such", "--json", "--no-refresh"],
		},
		{
			name: "check stored key",
			args: ["auth", "check", "--provider", "openai", "--no-refresh"],
			arrange: STORED_KEY,
		},
		{
			name: "check stored key json",
			args: ["auth", "check", "--provider", "openai", "--json", "--no-refresh"],
			arrange: STORED_KEY,
		},
		{
			name: "check stored key credentials",
			args: ["auth", "check", "--provider", "openai", "--json", "--credentials", "--no-refresh"],
			arrange: STORED_KEY,
		},
		{
			name: "check stored claude cli account json",
			args: ["auth", "check", "--provider", "anthropic-subscription", "--json", "--no-refresh"],
			arrange: STORED_CLI_ACCOUNT,
		},
		{ name: "print-api-key without a target", args: ["auth", "print-api-key"] },
		{
			name: "print-api-key stored key",
			args: ["auth", "print-api-key", "--provider", "openai"],
			arrange: STORED_KEY,
		},
		{
			name: "print-bearer-token bad min-expiry",
			args: ["auth", "print-bearer-token", "--provider", "x", "--min-expiry", "-1"],
		},
		{ name: "check rejects a json flag on print", args: ["auth", "print-api-key", "--json"] },
	],
	sessionFlags: [
		{ name: "fork with session", args: ["--fork", "a", "--session", "b", "-p", "x"] },
		{ name: "rebind with session-id", args: ["--rebind", "a", "--session-id", "b", "-p", "x"] },
		{ name: "session-id with continue", args: ["--session-id", "b", "--continue", "-p", "x"] },
		{ name: "invalid session-id", args: ["--session-id", "../x", "-p", "x"] },
		{ name: "rpc with a file", args: ["--mode", "rpc", "@prompt.md"] },
		{ name: "hand with a prompt", args: ["--hand", "hi"] },
		{ name: "headless with print", args: ["--headless", "-p", "x"] },
	],
	listModels: [
		{ name: "bad session runtime", args: ["--list-models", "--session-runtime", "bogus"] },
		{ name: "no extensions no match", args: ["--list-models", "zzzz-no-such-model", "--no-extensions"] },
		{
			name: "skills and themes no match",
			args: ["--list-models", "zzzz-no-such-model", "--no-skills", "--no-themes"],
		},
	],
};

describe("CLI paths E1a-s moved onto shared cores (senpi#7451 no-behaviour-change baseline)", () => {
	for (const [group, cases] of Object.entries(GROUPS)) {
		describe(group, () => {
			for (const golden of cases) {
				it(golden.name, () => {
					const cleanup = golden.arrange?.() ?? (() => {});
					try {
						expect(cli(...golden.args)).toMatchSnapshot();
					} finally {
						cleanup();
					}
				});
			}
		});
	}
});
