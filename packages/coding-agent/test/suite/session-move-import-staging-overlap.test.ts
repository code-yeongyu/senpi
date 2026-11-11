/**
 * Two imports of one move stage in folders of their own (senpi#4016, L3). Both pass `beginReceive` while the record is
 * receiving, so they staged in one folder per MOVE: the later one removed that folder and copied again while the
 * earlier one was still assembling in it, and the earlier one then committed whatever was there. Each attempt now
 * assembles its own folder and commits only what it staged itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, exportedForB, move } from "./rpc-move-session-support.ts";

describe("two imports of one move stage apart (senpi#4016)", () => {
	it("#given a first import held between its copy and its moved-in entry #when a second import of the same move stages #then the first's staged file is still there, both settle, and one session lands with the whole transcript", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const bundleDir = await exportedForB(a, b, fixture, "move-stage-1");
		const sessionDir = getDefaultSessionDir(fixture.repoB, fixture.agentB);
		const staged: string[] = [];
		const firstCopied = Promise.withResolvers<void>();
		let releaseFirst = (): void => {};
		const secondStaged = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		// The staged file is opened to append its moved-in entry, right after the copy: the window the second import
		// used to remove the folder in. The real open runs; only this caller's return is held.
		const openAsync = SessionManager.openAsync.bind(SessionManager);
		vi.spyOn(SessionManager, "openAsync").mockImplementation(
			async (...args: Parameters<typeof SessionManager.openAsync>) => {
				const manager = await openAsync(...args);
				const [file] = args;
				if (typeof file === "string" && file.includes(".move-staging")) {
					staged.push(file);
					if (staged.length === 1) {
						firstCopied.resolve();
						await secondStaged;
					}
				}
				return manager;
			},
		);
		const ledger = new MoveLedger(join(fixture.agentB, "session-moves", "ledger"));
		const settled = <T>(work: Promise<T>) =>
			work.then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error: String(error) }),
			);
		const importing = () =>
			importMovedSession({ bundleDir, targetCwd: fixture.repoB, ledger, sessionDir, from: "device-a" });

		const first = settled(importing());
		await firstCopied.promise;
		const second = await settled(importing());
		// Read before the first is let go: this is the moment the shared folder was removed under it.
		const firstStagedSurvived = existsSync(staged[0] ?? "");
		releaseFirst();
		const firstOutcome = await first;

		expect(firstStagedSurvived, `the first attempt staged ${staged[0]}, removed by the second`).toBe(true);
		expect(staged[1], JSON.stringify(staged)).not.toBe(staged[0]);
		expect(firstOutcome, JSON.stringify(firstOutcome)).toMatchObject({ ok: true });
		expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
		const landed = [firstOutcome, second].flatMap((outcome) => (outcome.ok ? [outcome.value.sessionFile] : []));
		expect(new Set(landed).size).toBe(1);
		const file = landed[0] ?? "";
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("remember 42");
		expect(basename(file)).toBe(basename(fixture.sessionPath));
		expect((await move(b, { op: "status", moveId: "move-stage-1" })).data).toMatchObject({ state: "accepted" });
		vi.restoreAllMocks();
	});
});
