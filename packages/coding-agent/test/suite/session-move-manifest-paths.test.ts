/**
 * Manifest paths are bundle paths, written with `/` whatever the sender's OS (senpi#3681 review): the receiver strips
 * the `files/` and `state/` prefixes by that separator. `join` is swapped for the Windows one on relative paths here,
 * so a manifest built with the platform `join` shows up as `state\probe\state.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type * as NodePath from "node:path";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { setup, writeSession } from "./session-move-fixture.ts";

vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof NodePath>();
	const windowsJoinForRelative = (...parts: string[]): string =>
		parts[0] !== undefined && !actual.isAbsolute(parts[0]) ? actual.win32.join(...parts) : actual.join(...parts);
	return { ...actual, join: windowsJoinForRelative, default: { ...actual, join: windowsJoinForRelative } };
});

describe("move manifest paths (senpi#3681 review)", () => {
	it("#given extension state and sidecars #when the bundle is written #then every manifest path uses '/'", async () => {
		const { base, ledger } = await setup();
		const source = writeSession(join(base, "a2", "repo"));
		const state = join(base, "state-out");
		mkdirSync(join(state, "probe"), { recursive: true });
		writeFileSync(join(state, "probe", "state.json"), '{"tasks":3}\n');
		const moveId = "move-81" as MoveId;
		await ledger.prepare(moveId);

		const manifest = await exportSessionForMove({
			sessionFile: source,
			moveId,
			target: "device-b",
			droppedUserMessages: [],
			bundleDir: join(base, "bundle-paths"),
			extensionStateDir: state,
		});

		expect(manifest.payloads.flatMap((payload) => payload.files.map((file) => file.path))).toEqual([
			"state/probe/state.json",
		]);
		expect(manifest.sidecars.map((file) => file.path)).toEqual([
			expect.stringMatching(/^files\/extensions\/goal\/[^\\]+\.json$/),
		]);
	});
});
