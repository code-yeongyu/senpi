import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const QUARANTINE_ROOT_ENV = "SENPI_VITEST_QUARANTINE_ROOT";

export default function setup(): (() => void) | undefined {
	if (process.env.SENPI_CODING_AGENT_DIR || process.env[QUARANTINE_ROOT_ENV]) return;

	const quarantineRoot = mkdtempSync(join(tmpdir(), "senpi-vitest-"));
	process.env[QUARANTINE_ROOT_ENV] = quarantineRoot;

	return () => {
		if (process.env[QUARANTINE_ROOT_ENV] === quarantineRoot) {
			delete process.env[QUARANTINE_ROOT_ENV];
		}
		rmSync(quarantineRoot, { recursive: true, force: true });
	};
}
