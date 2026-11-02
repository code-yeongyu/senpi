import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");

test("keeps the provider SDK out of the Node session worker bundle", () => {
	// Given: freshly built workspace output and the production Node bundle builder.
	const bundle = join(repo, "packages/coding-agent/dist/bundle");
	// When
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120000,
	});
	// Then
	expect(result.status, result.stderr).toBe(0);
	const worker = readdirSync(bundle, { recursive: true }).find((path) => String(path).endsWith("session-worker.js"));
	expect(worker).toBeDefined();
	if (worker === undefined) throw new Error("Node session worker bundle is absent");
	expect(readFileSync(join(bundle, String(worker)), "utf8")).not.toContain("client-bedrock-runtime");
}, 130000);
