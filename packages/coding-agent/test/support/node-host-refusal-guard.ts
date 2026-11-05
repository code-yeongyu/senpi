import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, expect } from "vitest";
import { NODE_HOST_REFUSAL_LOG_ENV, NODE_HOST_REFUSED } from "../../src/core/session-store/node-guard.ts";
import { NODE_HOST_REFUSAL_TEST_FILES } from "../bun-hosted-tests.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");

/**
 * Node runs only (senpi#6036): a test file that reaches session state on Node, in process or through a CLI or host child
 * that inherits the log variable, fails at its end with an error that names it and the list it belongs on.
 */
export function installNodeHostRefusalGuard(): void {
	const testPath = expect.getState().testPath;
	if (testPath === undefined) return;
	const file = relative(PACKAGE_ROOT, testPath).split(sep).join("/");
	const dir = mkdtempSync(join(tmpdir(), "senpi-node-host-refusal-"));
	const log = join(dir, "refusals.log");
	process.env[NODE_HOST_REFUSAL_LOG_ENV] = log;
	afterAll(() => {
		const refusals = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
		rmSync(dir, { recursive: true, force: true });
		if (refusals === 0 || NODE_HOST_REFUSAL_TEST_FILES.includes(file)) return;
		throw new Error(
			`${file} reached session state on Node (${NODE_HOST_REFUSED}, ${refusals} refusal(s)): add it to BUN_HOSTED_TEST_FILES in test/bun-hosted-tests.ts, or stub the JSONL hatch (SENPI_SESSION_STORE=jsonl) in a beforeEach if it must run on Node.`,
		);
	});
}
