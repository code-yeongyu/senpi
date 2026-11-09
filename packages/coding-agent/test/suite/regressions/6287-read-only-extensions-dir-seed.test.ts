import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_PREFIX } from "../../../src/config.ts";
import { GENERATED_SHIM_BANNER } from "../../../src/core/generated-shim-banner.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

/**
 * senpi#6287: a review child runs with the agent dir's extensions/ read-only (bwrap --ro-bind, or a
 * Seatbelt file-write deny). Seeding the global default extension shims threw EROFS out of
 * ensureGlobalDefaultExtensions, so the child died at startup whenever its seeded copy differed from
 * the running engine's (any host running two engine versions) or was missing.
 */
const runningAsRoot = process.getuid?.() === 0;

describe.skipIf(runningAsRoot)("#6287 seeding default extensions into a read-only extensions dir", () => {
	let tempDir: string;
	let agentDir: string;
	let extensionsDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-6287-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		for (const key of ["SENPI_CODING_AGENT_DIR", `${ENV_PREFIX}_CODING_AGENT_DIR`]) saved[key] = process.env[key];
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		process.env[`${ENV_PREFIX}_CODING_AGENT_DIR`] = agentDir;
	});

	afterEach(() => {
		chmodSync(extensionsDir, 0o755);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function loader(): DefaultResourceLoader {
		return new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}

	it("#given a generated shim from another engine install and a read-only extensions dir #when resources load #then loading succeeds and the shim is left as it was", async () => {
		const otherInstall = join(tempDir, "other-install", "dist", "core", "extensions", "builtin", "diff.js");
		const stale = `${GENERATED_SHIM_BANNER}export { default } from ${JSON.stringify(`file://${otherInstall}`)};\n`;
		writeFileSync(join(extensionsDir, "diff.js"), stale);
		chmodSync(join(extensionsDir, "diff.js"), 0o444);
		chmodSync(extensionsDir, 0o555);

		const resourceLoader = loader();
		await resourceLoader.reload();

		expect(readFileSync(join(extensionsDir, "diff.js"), "utf-8")).toBe(stale);
		expect(resourceLoader.getExtensions().errors).toEqual([]);
	});

	it("#given no seeded shims and a read-only extensions dir #when resources load #then loading succeeds", async () => {
		chmodSync(extensionsDir, 0o555);

		const resourceLoader = loader();
		await resourceLoader.reload();

		expect(resourceLoader.getExtensions().errors).toEqual([]);
	});
});
