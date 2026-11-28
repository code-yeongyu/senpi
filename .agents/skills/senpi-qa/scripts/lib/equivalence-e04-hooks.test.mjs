import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import e04 from "../../scenarios/fused-equivalence/cases/e04-order-once-mutation-block.mjs";

// senpi#6889: two repeatable hook-less runs must not qualify as a recording.
test("E04 refuses to finish a case missing a command hook", async () => {
	const hooks = ['pre({"value":42})', 'pre({"value":7})', 'post({"value":42})'];
	for (const missing of [...hooks, undefined]) {
		const cwd = mkdtempSync(join(tmpdir(), "eq-e04-"));
		try {
			const run = e04.drive({
				box: { cwd },
				open: async () => {},
				prompt: async () => writeFileSync(join(cwd, "trace.log"), hooks.filter((hook) => hook !== missing).join("\n")),
				close: async () => {},
				reopenState: async () => {},
			});
			if (missing === undefined) await run;
			else await assert.rejects(run, { message: `E04 trace.log lacks command hook: ${missing}` });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});
