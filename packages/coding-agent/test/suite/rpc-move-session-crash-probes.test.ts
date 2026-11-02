/**
 * The #4004 review probes, rebuilt from the state each crash leaves on disk: an import interrupted after its rename,
 * a failure after the rename, and a revoke whose ledger mark was lost. In each the ledger must agree with the files,
 * at most one copy may be writable, and the revoke mark must survive.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, exportedForB, importedOnB, move } from "./rpc-move-session-support.ts";

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);
const writable = (file: string) => existsSync(file) && sessionOwnership(loadEntriesFromFile(file)).writable;
const rewrite = (file: string, change: (record: Record<string, unknown>) => Record<string, unknown>) =>
	writeFileSync(
		file,
		`${JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>))}\n`,
	);

describe("move_session crash probes from the #4004 review", () => {
	it("#given an import stopped after its rename (record still receiving, stamped committing) and the copy was deleted #when the import is retried #then it is refused and nothing lands", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-c1");
		rewrite(ledgerFile(fixture.agentB, "move-c1"), ({ target }) => ({
			state: "receiving",
			target,
			committing: true,
		}));
		rmSync(onB);
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-c1");

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" })).toMatchObject({
			success: false,
			error: "move_fenced",
		});
		expect(existsSync(onB)).toBe(false);
	});

	it("#given a failure right after the rename #then the ledger never answers failed beside the landed copy, and only one copy ends writable", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const bundleDir = await exportedForB(a, b, fixture, "move-c2");
		class FailsAfterRename extends MoveLedger {
			override commit<T>(
				moveId: Parameters<MoveLedger["commit"]>[0],
				target: string,
				rename: () => T | Promise<T>,
				prepare?: () => void,
			) {
				return super.commit(
					moveId,
					target,
					async () => {
						await rename();
						throw new Error("disk error after the rename");
					},
					prepare,
				);
			}
		}
		const ledger = new FailsAfterRename(join(fixture.agentB, "session-moves", "ledger"));
		await expect(
			importMovedSession({
				bundleDir,
				targetCwd: fixture.repoB,
				ledger,
				sessionDir: getDefaultSessionDir(fixture.repoB, fixture.agentB),
				from: "device-a",
			}),
		).rejects.toThrow("disk error after the rename");
		const onB = join(getDefaultSessionDir(fixture.repoB, fixture.agentB), basename(fixture.sessionPath));
		expect(writable(onB)).toBe(true);

		const answer = (await move(b, { op: "status", moveId: "move-c2" })).data;
		expect(answer).toEqual({ state: "accepted" });
		await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-c2", answer });
		expect([writable(fixture.sessionPath), writable(onB)].filter(Boolean)).toHaveLength(1);
	});

	it("#given a revoke whose ledger mark was lost and a record left receiving #when the same file is imported again #then the revoke mark is kept", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-c3");
		await move(b, { op: "revoke", sessionPath: onB, moveId: "move-c3" });
		rewrite(ledgerFile(fixture.agentB, "move-c3"), ({ target }) => ({ state: "receiving", target }));
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-c3");

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" })).toMatchObject({
			success: true,
			data: { session_path: onB },
		});
		expect((await move(b, { op: "status", moveId: "move-c3" })).data).toEqual({ state: "accepted", revoked: true });
	});
});
