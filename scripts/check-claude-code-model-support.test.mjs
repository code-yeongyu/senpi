import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { catalogClaudeIds } from "./check-claude-code-model-support.mjs";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "check-claude-code-model-support.mjs");

function fixtureCatalog() {
	return {
		"anthropic-messages": {
			"chat:claude-sonnet-4-5": { id: "claude-sonnet-4-5", type: "chat" },
			"chat:claude-fable-9-9": { id: "claude-fable-9-9", type: "chat" },
			// Same id on a non-chat row must not count twice (or at all, here).
			"image:claude-fable-9-9": { id: "claude-fable-9-9", type: "image" },
			// No `id` field: fall back to the key with the `chat:` prefix stripped.
			"chat:claude-haiku-9-9": { type: "chat" },
		},
	};
}

function runStrict(catalogPath, binaryPath) {
	return spawnSync(process.execPath, [script, "--strict"], {
		encoding: "utf8",
		env: {
			...process.env,
			SENPI_CHECK_CATALOG_PATH: catalogPath,
			SENPI_CHECK_BINARY_PATH: binaryPath,
		},
	});
}

describe("catalogClaudeIds (senpi#6310)", () => {
	it("reads bare ids from chat rows, ignoring non-chat rows", () => {
		assert.deepEqual(catalogClaudeIds(fixtureCatalog()), ["claude-sonnet-4-5", "claude-fable-9-9", "claude-haiku-9-9"]);
	});

	it("yields a non-zero count for the real catalog", () => {
		const real = JSON.parse(
			readFileSync(join(root, "packages", "ai", "src", "providers", "data", "anthropic.json"), "utf8"),
		);
		const ids = catalogClaudeIds(real);
		assert.ok(ids.length > 0, "the real catalog must yield a non-zero id count");
		assert.ok(ids.includes("claude-sonnet-4-5"), "the control id must be among the catalog ids");
		assert.equal(new Set(ids).size, ids.length, "catalog ids must be unique");
		assert.ok(ids.every((id) => id.startsWith("claude-")), "every catalog id must be a bare claude- id");
	});
});

describe("--strict with a fixture binary (senpi#6310)", () => {
	it("exits 1 naming the catalog id absent from the fixture binary", () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-6310-"));
		try {
			const catalogPath = join(dir, "anthropic.json");
			writeFileSync(catalogPath, JSON.stringify(fixtureCatalog()));
			const binaryPath = join(dir, "claude");
			// Control id present; claude-fable-9-9 and claude-haiku-9-9 absent.
			writeFileSync(binaryPath, "binary blob claude-sonnet-4-5 padding");
			const run = runStrict(catalogPath, binaryPath);
			assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${run.stdout}${run.stderr}`);
			assert.match(run.stdout, /claude-fable-9-9/u);
			assert.match(run.stdout, /claude-haiku-9-9/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits 0 when the fixture binary knows every catalog id", () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-6310-"));
		try {
			const catalogPath = join(dir, "anthropic.json");
			writeFileSync(catalogPath, JSON.stringify(fixtureCatalog()));
			const binaryPath = join(dir, "claude");
			writeFileSync(binaryPath, "binary blob claude-sonnet-4-5 claude-fable-9-9 claude-haiku-9-9 padding");
			const run = runStrict(catalogPath, binaryPath);
			assert.equal(run.status, 0, `expected exit 0, got ${run.status}: ${run.stdout}${run.stderr}`);
			assert.match(run.stdout, /knows all 3 catalog Claude ids/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
