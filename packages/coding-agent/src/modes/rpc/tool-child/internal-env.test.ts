// senpi#3566 todo 4 (review MEDIUM 3): the list of tool-child-only variables names every one the server sets, and a
// command the real child starts inherits none of them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_CHILD_CHANNEL_ENV, TOOL_CHILD_ROLE_ENV, TOOL_CHILD_SECRET_ENV } from "./channel.ts";
import { ToolChildClient } from "./client.ts";
import { TOOL_CHILD_GENERATION_ENV } from "./entry.ts";
import {
	TOOL_CHILD_INTERNAL_ENV,
	TOOL_CHILD_LEDGER_ENV,
	TOOL_CHILD_REENTRY_ENV,
	TOOL_CHILD_REFS_ROOT_ENV,
} from "./launch-env-names.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const fixture = resolve(import.meta.dirname, "../../../../test/fixtures/tool-child-fixture.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("tool-child internal environment", () => {
	it("lists exactly the variables the server sets for the child", () => {
		expect([...TOOL_CHILD_INTERNAL_ENV].sort()).toEqual(
			[
				TOOL_CHILD_ROLE_ENV,
				TOOL_CHILD_CHANNEL_ENV,
				TOOL_CHILD_SECRET_ENV,
				TOOL_CHILD_GENERATION_ENV,
				TOOL_CHILD_LEDGER_ENV,
				TOOL_CHILD_MODULE_ROOTS_ENV,
				TOOL_CHILD_REFS_ROOT_ENV,
				// senpi#3590 review MEDIUM 2: launch.ts sets it, so the child scrubs it too.
				TOOL_CHILD_REENTRY_ENV,
			].sort(),
		);
	});

	it.skipIf(process.platform === "win32")(
		"never reaches a command the child starts",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "tie-"));
			const instance = new ToolChildClient({
				dir,
				cwd: dir,
				command: { command: process.execPath, args: ["--import", resolver, fixture] },
				env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: "[]" },
			});
			cleanups.push(async () => {
				await instance.close();
				await rm(dir, { recursive: true, force: true });
			});
			await instance.start();
			const seen = (await instance.run("childEnv", null)) as { names: string[] };
			const internal = new Set<string>(TOOL_CHILD_INTERNAL_ENV);
			expect(seen.names.filter((name) => internal.has(name))).toEqual([]);
		},
		30_000,
	);
});
