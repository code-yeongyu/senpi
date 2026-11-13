import { afterEach, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ tz: [] as unknown[] }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: ((
			command: string,
			_args: readonly string[],
			options: { env?: NodeJS.ProcessEnv },
			callback: unknown,
		) => {
			if (typeof callback !== "function") throw new Error("execFile without a callback");
			spawned.tz.push(options.env?.TZ);
			if (command !== "ps") throw new Error(`unexpected ${command}`);
			// 06:30Z on 2026-11-01 is 01:30 EST, the SECOND 01:30 of New York's fall-back night.
			const lstart = options.env?.TZ === "UTC" ? "Sun Nov  1 06:30:00 2026" : "Sun Nov  1 01:30:00 2026";
			queueMicrotask(() => callback(null, `${lstart} /usr/local/bin/held-task\n`));
			return undefined;
		}) as unknown as typeof actual.execFile,
	};
});

import { confirmOwner } from "../../../src/core/extensions/builtin/terminal/orphan-reaper.ts";

const zone = process.env.TZ;
afterEach(() => {
	if (zone === undefined) delete process.env.TZ;
	else process.env.TZ = zone;
	spawned.tz.length = 0;
});

it("confirms a macOS orphan started in the repeated fall-back hour, reading ps lstart in UTC", async () => {
	process.env.TZ = "America/New_York";
	const runtime = {
		pid: 4242,
		bootAtMs: 1_000,
		startedAtMs: Date.UTC(2026, 10, 1, 6, 30, 0),
		argv: ["/usr/local/bin/held-task"],
	};

	const verdict = await confirmOwner(runtime, undefined, {
		platform: "darwin",
		isProcessAlive: () => true,
		bootAtMs: () => 1_000,
	});

	expect({ verdict, tz: spawned.tz }).toEqual({ verdict: "confirmed", tz: ["UTC"] });
});
