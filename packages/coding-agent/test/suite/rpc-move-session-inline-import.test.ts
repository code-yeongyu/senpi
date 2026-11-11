/**
 * `move_session import` with `files` (senpi#6267): the bundle arrives inline in place of a folder and is verified
 * exactly like one. A file that fails the check and a request that is not a bundle are refused, and nothing is left
 * staged. What a sent path may be is in `rpc-move-session-inline-paths.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { move } from "./rpc-move-session-support.ts";
import {
	changed,
	exported,
	type InlineFile,
	inlineFile,
	inlineOf,
	landedOn,
	SESSION_FILE,
	SIDECAR_FILE,
	stagedOn,
} from "./rpc-move-session-inline-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

describe("move_session import with files (senpi#6267)", () => {
	it("#given the inline files #when B imports them without a folder #then the session lands as it does from a folder, and of the folders left under incoming only an inline one an hour old is removed", async () => {
		const { fixture, a, b, reply } = await exported("move-i2", { inline: true, droppedUserMessages: ["queued"] });
		await using _a = a;
		await using _b = b;
		const leftUnderIncoming = (name: string, modified?: Date) => {
			const dir = join(fixture.agentB, "session-moves", "incoming", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "left"), "x\n");
			if (modified !== undefined) utimesSync(dir, modified, modified);
		};
		leftUnderIncoming("inline-died-long-ago", new Date(0));
		leftUnderIncoming("inline-in-use-now");
		leftUnderIncoming("not-an-inline-folder", new Date(0));

		const imported = await move(b, { op: "import", files: inlineOf(reply), cwd: fixture.repoB, from: "device-a" });

		expect(imported).toMatchObject({
			success: true,
			data: { session_id: SESSION_ID, session_path: landedOn(fixture) },
		});
		const onB = landedOn(fixture);
		expect(readFileSync(onB, "utf8")).toContain("remember 42");
		expect(readFileSync(onB, "utf8")).toContain("queued");
		expect(readFileSync(join(dirname(onB), "extensions", "goal", `${SESSION_ID}.json`), "utf8")).toBe(
			'{"goal":"ship"}\n',
		);
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "on B", timestamp: 3 }),
		).not.toThrow();
		expect(await move(b, { op: "status", moveId: "move-i2" })).toMatchObject({ data: { state: "accepted" } });
		expect(stagedOn(fixture.agentB)).toEqual([
			"incoming/inline-in-use-now/left",
			"incoming/not-an-inline-folder/left",
		]);
		expect(
			await move(a, {
				op: "finish",
				sessionPath: fixture.sessionPath,
				moveId: "move-i2",
				answer: { state: "accepted" },
			}),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
	});

	it.each<[string, (files: InlineFile[]) => InlineFile[], Record<string, string>]>([
		[
			"a file whose bytes changed in transit",
			(files) => files.map((file) => (file.path === SESSION_FILE ? changed(file) : file)),
			{ state: "failed", reason: "bundle_invalid" },
		],
		[
			"a file sent with a sha256 that is not its bytes'",
			(files) => files.map((file) => (file.path === SIDECAR_FILE ? { ...file, sha256: "0".repeat(64) } : file)),
			{ state: "failed", reason: "bundle_invalid" },
		],
		[
			"a file the manifest lists but the request leaves out",
			(files) => files.filter((file) => file.path !== SIDECAR_FILE),
			{ state: "failed", reason: "bundle_invalid" },
		],
		[
			// The manifest names the move, so a manifest that cannot be trusted settles no move's record.
			"a manifest whose bytes changed in transit",
			(files) => files.map((file) => (file.path === "manifest.json" ? changed(file) : file)),
			{ state: "receiving" },
		],
		["no manifest", (files) => files.filter((file) => file.path !== "manifest.json"), { state: "receiving" }],
	])("#given %s #then import refuses move_bundle_invalid and lands nothing", async (_case, tamper, status) => {
		const { fixture, a, b, reply } = await exported("move-i3");
		await using _a = a;
		await using _b = b;

		const refused = await move(b, { op: "import", files: tamper(inlineOf(reply)), cwd: fixture.repoB });

		expect(refused).toMatchObject({
			success: false,
			errorCode: "move_bundle_invalid",
			errorData: { detail: expect.any(String) },
		});
		expect(existsSync(landedOn(fixture))).toBe(false);
		expect(stagedOn(fixture.agentB)).toEqual([]);
		expect((await move(b, { op: "status", moveId: "move-i3" })).data).toEqual(status);
	});

	it.each<[string, (files: InlineFile[], bundleDir: string) => Record<string, unknown>]>([
		["both a folder and files", (files, bundleDir) => ({ files, bundleDir })],
		["files that are not a list", () => ({ files: "manifest.json" })],
		[
			"a file with no bytes field",
			(files) => ({ files: files.map(({ path, sha256: sum }) => ({ path, sha256: sum })) }),
		],
		["bytes that are not base64", (files) => ({ files: files.map((file) => ({ ...file, base64: "not base64!" })) })],
		[
			"files over the engine's 1 MiB cap",
			(files) => ({ files: [...files, inlineFile("files/big.bin", Buffer.alloc(1024 * 1024, 1))] }),
		],
		[
			"more files than an inline import takes",
			() => ({ files: Array.from({ length: 1025 }, (_, at) => inlineFile(`files/n${at}`, Buffer.from("x"))) }),
		],
		[
			"one file as long as a line may carry",
			(files) => ({
				files: [...files, { path: "files/big.bin", sha256: "0".repeat(64), base64: "A".repeat(15 * 1024 * 1024) }],
			}),
		],
	])("#given %s #then import refuses invalid_move_request and the move stays importable", async (_case, fields) => {
		const { fixture, a, b, reply } = await exported("move-i8");
		await using _a = a;
		await using _b = b;
		const { bundle_dir: bundleDir } = reply.data as { bundle_dir: string };

		const refused = await move(b, { op: "import", cwd: fixture.repoB, ...fields(inlineOf(reply), bundleDir) });

		expect(refused).toMatchObject({ success: false, errorCode: "invalid_move_request" });
		expect(existsSync(landedOn(fixture))).toBe(false);
		expect(stagedOn(fixture.agentB)).toEqual([]);
		expect(await move(b, { op: "import", files: inlineOf(reply), cwd: fixture.repoB })).toMatchObject({
			success: true,
			data: { session_id: SESSION_ID },
		});
	});
});
