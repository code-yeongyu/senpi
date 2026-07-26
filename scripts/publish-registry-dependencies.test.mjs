import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PRIVATE_UPSTREAM_WORKSPACES = [
	{ packageJsonPath: "packages/ai/package.json", packageName: "@earendil-works/pi-ai" },
	{ packageJsonPath: "packages/agent/package.json", packageName: "@earendil-works/pi-agent-core" },
	{ packageJsonPath: "packages/tui/package.json", packageName: "@earendil-works/pi-tui" },
	{ packageJsonPath: "packages/pty/package.json", packageName: "@earendil-works/pi-pty" },
];
const OWNED_REGISTRY_ALIASES = [
	"@code-yeongyu/senpi-ai",
	"@code-yeongyu/senpi-agent-core",
	"@code-yeongyu/senpi-tui",
	"@code-yeongyu/senpi-pty",
	"@code-yeongyu/senpi-codemode",
	"@code-yeongyu/senpi",
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("npm publish dependency graph", () => {
	it("keeps upstream workspaces private and publishes owned registry aliases", () => {
		// Given: Bun resolves declared edges from the registry, but npm only packs the
		// original import paths when their dependency keys remain in the manifest.
		const publishScript = readFileSync(join(repoRoot, "scripts", "publish.mjs"), "utf8");

		for (const workspace of PRIVATE_UPSTREAM_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));
			assert.equal(manifest.private, true, `${workspace.packageName} must remain private`);
		}
		for (const packageName of OWNED_REGISTRY_ALIASES) {
			assert.match(publishScript, new RegExp(`name: "${packageName}"`));
		}
	});
});
