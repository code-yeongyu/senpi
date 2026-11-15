/**
 * senpi#6484, part 4: `move_session { op: "ownership" }` is the sender's read-only question "is this file sealed for
 * move X": it reads the session file and changes nothing (the bundle, the staged state and the files stay
 * byte-identical), unlike an export (which rewrites the bundle) or a finish.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { bindingSettled, replaceInSameFolder } from "./rpc-replacement-follow-support.ts";

type Wire = Record<string, unknown>;
const send = (command: Wire): RpcCommand & { id: string } => command as unknown as RpcCommand & { id: string };
const MOVE = "move-x" as MoveId;

/** Every file under `root` with its bytes, keyed by its path below `root`; `{}` when `root` does not exist. */
function filesUnder(root: string, prefix = ""): Record<string, string> {
	if (!existsSync(root)) return {};
	const files: Record<string, string> = {};
	for (const name of readdirSync(root)) {
		const full = join(root, name);
		if (statSync(full).isDirectory()) Object.assign(files, filesUnder(full, `${prefix}${name}/`));
		else files[`${prefix}${name}`] = readFileSync(full).toString("base64");
	}
	return files;
}

describe('move_session { op: "ownership" } (senpi#6484, part 4)', () => {
	it("answers whether a file is sealed for a move and held by it, and changes nothing", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { handle, old, next } = await replaceInSameFolder(host, "new_session");
		await bindingSettled(host, handle);
		await host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: handle,
				reason: "move",
				moveId: MOVE,
				target: "device-b",
			}),
		);
		const exported = await host.send(
			send({
				type: "move_session",
				id: "export",
				op: "export",
				sessionPath: next.sessionFile,
				moveId: MOVE,
				target: "device-b",
			}),
		);
		expect(exported).toMatchObject({ success: true });
		const bundleDir = String((exported.data as Wire).bundle_dir);
		const snapshot = () => ({
			bundle: filesUnder(bundleDir),
			staged: filesUnder(outgoingStateDir(next.sessionFile, MOVE)),
			sealed: readFileSync(next.sessionFile, "utf8"),
			other: readFileSync(old.sessionFile, "utf8"),
		});
		const before = snapshot();
		expect(Object.keys(before.bundle).length).toBeGreaterThan(0);
		const ask = (sessionPath: string, moveId: string) =>
			host.send(send({ type: "move_session", id: `ask-${moveId}`, op: "ownership", sessionPath, moveId }));

		expect(await ask(next.sessionFile, MOVE)).toMatchObject({
			success: true,
			data: { ownership: "moving", sealed_for_move: true, held_this_move: true },
		});
		expect(await ask(old.sessionFile, MOVE)).toMatchObject({
			success: true,
			data: { ownership: "writable", sealed_for_move: false, held_this_move: false },
		});
		expect(await ask(next.sessionFile, "move-y")).toMatchObject({
			success: true,
			data: { ownership: "moving", sealed_for_move: false, held_this_move: false },
		});

		expect(snapshot()).toEqual(before);
	}, 120_000);

	it("refuses a path with no session file, never answering writable, and creates nothing", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const s1 = await host.open("s1");
		const folder = dirname(s1.sessionPath);
		const missing = join(folder, "no-such-session.jsonl");
		const headerless = join(folder, "not-a-session.jsonl");
		writeFileSync(headerless, `${JSON.stringify({ type: "custom", customType: "note", data: {} })}\n`);
		// Only the places this command could write. The folder as a whole also holds the engine's own files (its log, its
		// scheduler's beat, its inbox markers), which come and go by themselves.
		const owned = () => ({
			transcripts: readdirSync(folder)
				.filter((name) => name.endsWith(".jsonl"))
				.sort(),
			session: readFileSync(s1.sessionPath, "utf8"),
			headerless: readFileSync(headerless, "utf8"),
			staged: filesUnder(outgoingStateDir(missing, MOVE)),
			moves: filesUnder(join(folder, "agent", "session-moves")),
		});
		const before = owned();

		for (const sessionPath of [missing, headerless]) {
			const answer = await host.send(
				send({ type: "move_session", id: `ask-${sessionPath}`, op: "ownership", sessionPath, moveId: MOVE }),
			);
			expect(answer).toMatchObject({ success: false, errorCode: "not_a_session_file" });
			expect(JSON.stringify(answer)).not.toContain("writable");
		}

		expect(existsSync(missing)).toBe(false);
		expect(owned()).toEqual(before);
	}, 120_000);

	it("records nothing about a move it was asked about, unlike a status", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { handle, next } = await replaceInSameFolder(host, "new_session");
		await bindingSettled(host, handle);
		await host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: handle,
				reason: "move",
				moveId: MOVE,
				target: "device-b",
			}),
		);
		const exported = await host.send(
			send({
				type: "move_session",
				id: "export",
				op: "export",
				sessionPath: next.sessionFile,
				moveId: MOVE,
				target: "device-b",
			}),
		);
		// `<agent dir>/session-moves`: the outgoing bundles and the move ledger.
		const moves = dirname(dirname(String((exported.data as Wire).bundle_dir)));
		const before = filesUnder(moves);

		const answer = await host.send(
			send({
				type: "move_session",
				id: "ask",
				op: "ownership",
				sessionPath: next.sessionFile,
				moveId: "move-never-seen",
			}),
		);

		expect(answer).toMatchObject({ success: true, data: { sealed_for_move: false, held_this_move: false } });
		expect(filesUnder(moves)).toEqual(before);
	}, 120_000);
});
