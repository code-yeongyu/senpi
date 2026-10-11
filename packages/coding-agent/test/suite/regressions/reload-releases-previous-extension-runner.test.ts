import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Retention contract: a session reload must leave the previous extension generation collectable.
// Every config-reload (a watched settings or omo.jsonc edit) reloads every live session, so a
// retained generation grows a long-lived worker by tens of MB per reload: 465 reloads held 15.6GB.
// It runs under Bun so the native extension importer and its module cache are the ones exercised.
const sdkPath = fileURLToPath(new URL("../../../src/core/sdk.ts", import.meta.url));
const sessionManagerPath = fileURLToPath(new URL("../../../src/core/session-manager.ts", import.meta.url));
const moduleCachePath = fileURLToPath(
	new URL("../../../src/core/extensions/extension-module-cache.ts", import.meta.url),
);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session reload retention", () => {
	it("releases the previous extension runner and compiles no new module generation for unchanged sources", () => {
		// Given: a session with every builtin extension and an isolated agent dir.
		const root = mkdtempSync(join(tmpdir(), "senpi-reload-retention-"));
		roots.push(root);
		writeFileSync(join(root, "settings.json"), "{}\n");
		const output = execFileSync(
			"bun",
			[
				"--eval",
				`
import { createAgentSession } from ${JSON.stringify(sdkPath)};
import { SessionManager } from ${JSON.stringify(sessionManagerPath)};
import { extensionModuleGenerationCount } from ${JSON.stringify(moduleCachePath)};
const root = ${JSON.stringify(root)};
const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root) });
await session.bindExtensions({ onError: () => {} });
const generations = extensionModuleGenerationCount();
const previous = [];
// When: the session reloads with no extension source changed.
for (let reload = 0; reload < 6; reload++) {
	previous.push(new WeakRef(session._extensionRunner));
	await session.reload();
}
await new Promise(setImmediate);
await new Promise(setImmediate);
Bun.gc(true);
console.log(JSON.stringify({
	retained: previous.filter(ref => ref.deref() !== undefined).length,
	newGenerations: extensionModuleGenerationCount() - generations,
}));
process.exit(0);
`,
			],
			{ cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, SENPI_CODING_AGENT_DIR: root } },
		);
		const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
			retained: number;
			newGenerations: number;
		};
		// Then: no new module graph was compiled, and at most the runner replaced by the last reload
		// (still reachable for one turn while that reload settles) is alive.
		expect(result.newGenerations).toBe(0);
		expect(result.retained).toBeLessThanOrEqual(1);
	});
});
