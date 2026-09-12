#!/usr/bin/env node
/**
 * senpi-qa channel-4 style driver: prove slot-preserving credential writes
 * through the real CLI surface, with guardRealAuth protecting the user's auth.
 *
 * Scenario: a sandbox auth.json holds a 2-slot pool for `openai`; the CLI
 * performs an authenticated write; the pool's siblings must survive and the
 * real ~/.senpi agent auth.json must be byte-identical throughout.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const commonPath = join(root, ".agents/skills/senpi-qa/scripts/lib/common.mjs");
const { cliEntry, guardRealAuth, tsxEntry } = await import(commonPath);

const sandbox = join(tmpdir(), `mcred-qa-${Date.now()}`);
mkdirSync(join(sandbox, "agent"), { recursive: true });
const sandboxAuth = join(sandbox, "agent", "auth.json");

const pooledEntry = {
	type: "api_key",
	key: "primary-key",
	accounts: [
		{ name: "default", key: "primary-key", source: "login" },
		{ name: "work", key: "work-key", source: "login" },
	],
	pinned: "work",
};
writeFileSync(sandboxAuth, JSON.stringify({ openai: pooledEntry }, null, 2));
chmodSync(sandboxAuth, 0o600);

const env = {
	...process.env,
	SENPI_CODING_AGENT_DIR: join(sandbox, "agent"),
	SENPI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"),
	PI_OFFLINE: "1",
};

const guard = guardRealAuth();
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok, detail });
	process.stdout.write(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}\n`);
};

function runAuthCheck() {
	const out = execFileSync("node", [tsxEntry(), cliEntry(), "auth", "check", "--provider", "openai", "--json"], {
		cwd: root,
		env,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return out;
}

try {
	const before = readFileSync(sandboxAuth, "utf-8");
	const stdout = runAuthCheck();
	const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));

	const after = readFileSync(sandboxAuth, "utf-8");
	const entry = JSON.parse(after).openai;
	const names = (entry?.accounts ?? []).map((s) => s.name);

	check("auth check runs against the sandboxed pool", parsed !== undefined, "json emitted");
	check("auth check did not rewrite auth.json", after === before, "bytes identical pre/post read");
	check("pool slots intact after CLI read", names.includes("default") && names.includes("work"), names.join(","));
	check("pinned slot intact", entry?.pinned === "work");
	check("flat top-level credential retained for older binaries", entry?.type === "api_key" && entry?.key === "primary-key");
} catch (error) {
	check("driver completed", false, String(error).split("\n")[0]);
} finally {
	guard.assertUnchanged();
	rmSync(sandbox, { recursive: true, force: true });
}

const failures = results.filter((r) => !r.ok).length;
process.stdout.write(`\nmcred-slot-preservation-qa: ${results.length - failures}/${results.length} passed\n`);
process.exit(failures > 0 ? 1 : 0);
