/**
 * senpi#6752: `machine_op` runs the relay host's file, shell and mesh ops in the engine and answers each with the
 * relay host's `OpOutcome`, byte for byte. Byte payloads travel base64 in JSON (`args.bytes`, `response.bytes`); a
 * write too large for one line may hand its bytes over as a 0600 file (`args.bytes_path`) the engine reads and unlinks.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DelegatedHost, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { base64, outcome, runOp } from "./rpc-machine-op-support.ts";

let host: DelegatedHost;
let peer: Peer;
let root: string;

beforeAll(async () => {
	host = await startHost();
	peer = await host.proven();
	root = join(host.scratch, "work");
	await mkdir(root);
});
afterAll(async () => {
	await host.dispose();
});

const applied = (response: unknown) => outcome({ state: "applied", response });
async function privateDir(name: string): Promise<string> {
	const dir = join(host.scratch, name);
	await mkdir(dir, { mode: 0o700 });
	await chmod(dir, 0o700);
	return dir;
}

describe("senpi#6752: machine_op file, shell and mesh ops", () => {
	it("answers every fs op with the relay host's response shape, relative paths anchored at an unconfined root", async () => {
		const file = join(root, "rel.txt");
		expect(await runOp(peer, "fs.write", { path: "rel.txt", bytes: base64("hello world") }, { root })).toEqual(
			applied({ path: file, writtenBytes: 11 }),
		);
		expect(await runOp(peer, "fs.read", { path: file }, { root })).toEqual(
			applied({ path: file, bytes: base64("hello world"), size: 11, offset: 0 }),
		);
		expect(await runOp(peer, "fs.read_range", { path: file, offset: 6, length: 3 }, { root })).toEqual(
			applied({ path: file, bytes: base64("wor"), size: 11, offset: 6 }),
		);
		expect(await runOp(peer, "fs.edit", { path: file, exact: "world", replacement: "there" }, { root })).toEqual(
			applied({ path: file, replacements: 1, writtenBytes: 11 }),
		);
		expect(
			await runOp(peer, "fs.write_range", { path: file, offset: 0, bytes: base64("HELLO"), total: 11 }, { root }),
		).toEqual(applied({ path: file, writtenBytes: 5 }));
		expect(await readFile(file, "utf8")).toBe("HELLO there");
		const info = await stat(file);
		expect(await runOp(peer, "fs.stat", { path: file }, { root })).toEqual(
			applied({ path: file, type: "file", size: 11, mtimeMs: Math.floor(info.mtimeMs), mode: info.mode }),
		);
		const listed = join(root, "listed");
		await mkdir(listed);
		await writeFile(join(listed, "a.md"), "first\na needle\n");
		expect(await runOp(peer, "fs.list", { path: "listed" }, { root })).toEqual(
			applied({ path: listed, entries: [{ name: "a.md", type: "file" }] }),
		);
		expect(await runOp(peer, "fs.glob", { pattern: "*.md", cwd: "listed" }, { root })).toEqual(
			applied({ entries: [join(listed, "a.md")], truncated: false }),
		);
		expect(await runOp(peer, "fs.grep", { path: join(listed, "a.md"), pattern: "needle" }, { root })).toEqual(
			applied({ matches: [{ path: join(listed, "a.md"), line: 2, text: "a needle" }], truncated: false }),
		);
	});

	it("refuses a path outside a confined root and names an OS refusal on an unconfined one", async () => {
		const outside = join(host.scratch, "outside.txt");
		await writeFile(outside, "secret");
		expect(await runOp(peer, "fs.read", { path: outside }, { root, confined: true })).toEqual(
			outcome({
				state: "failed",
				error: { code: "policy_denied", message: `${outside} is outside the scope root` },
			}),
		);
		const locked = join(root, "locked");
		await mkdir(locked);
		await chmod(locked, 0o500);
		const target = join(locked, "x.txt");
		expect(await runOp(peer, "fs.write", { path: target, bytes: base64("x") }, { root })).toEqual(
			outcome({
				state: "failed",
				error: {
					code: "os_permission_denied",
					message: `EACCES: this device's OS user may not open ${target}. Use a path that user can access, or change its permissions on that device.`,
				},
			}),
		);
		await chmod(locked, 0o700);
	});

	it("runs shell where its relative cwd resolves under the root and answers mesh.message with exactly accepted, seq and inboxPath", async () => {
		expect(await runOp(peer, "shell", { command: "pwd -P; printf err >&2", cwd: "." }, { root })).toEqual(
			applied({
				exitCode: 0,
				signal: null,
				stdout: `${await realpath(root)}\n`,
				stderr: "err",
				timedOut: false,
				durationMs: expect.any(Number),
				truncated: false,
			}),
		);
		const inboxPath = join(host.scratch, "agent", "machine", "inbox", "t6752.jsonl");
		expect(await runOp(peer, "mesh.message", { topic: "t6752", body: { n: 1 } }, { root })).toEqual(
			applied({ accepted: true, seq: 1, inboxPath }),
		);
		expect(await runOp(peer, "mesh.message", { topic: "t6752", body: { n: 2 } }, { root })).toEqual(
			applied({ accepted: true, seq: 2, inboxPath }),
		);
	});

	it("lays the relay host's env_overlay last, over the same key in args.env", async () => {
		const args = { command: 'printf %s "$OVERLAY_6752"', env: { OVERLAY_6752: "sender" } };
		expect(await runOp(peer, "shell", args, { root, envOverlay: { OVERLAY_6752: "relay" } })).toEqual(
			applied({
				exitCode: 0,
				signal: null,
				stdout: "relay",
				stderr: "",
				timedOut: false,
				durationMs: expect.any(Number),
				truncated: false,
			}),
		);
	});

	it("refuses an op the engine does not serve and args that do not decode, running nothing", async () => {
		expect(await runOp(peer, "policy.get", {}, { root })).toEqual(
			outcome({ state: "refused", error: { code: "malformed", message: "unknown op policy.get" } }),
		);
		expect(await runOp(peer, "fs.write", { bytes: base64("x") }, { root })).toEqual(
			outcome({ state: "refused", error: { code: "malformed", message: "path is required" } }),
		);
	});

	it("runs an op that carries no deadline_ms without one", async () => {
		expect(await runOp(peer, "shell", { command: "printf ok" }, { root, deadlineMs: null })).toEqual(
			applied({
				exitCode: 0,
				signal: null,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				durationMs: expect.any(Number),
				truncated: false,
			}),
		);
	});

	it("aborts an op at its deadline", async () => {
		expect(await runOp(peer, "shell", { command: "sleep 30" }, { root, deadlineMs: Date.now() + 300 })).toEqual(
			outcome({ state: "cancelled", error: { code: "aborted", message: "the op was cancelled" } }),
		);
	});

	it("round-trips an 8 MiB write inline and through a handed-over 0600 file", async () => {
		const bytes = randomBytes(8 * 1024 * 1024);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const inline = join(root, "inline.bin");
		expect(await runOp(peer, "fs.write", { path: inline, bytes: bytes.toString("base64") }, { root })).toEqual(
			applied({ path: inline, writtenBytes: bytes.byteLength }),
		);
		expect(
			createHash("sha256")
				.update(await readFile(inline))
				.digest("hex"),
		).toBe(digest);
		const carrier = join(await privateDir("carriers"), "carrier.bin");
		await writeFile(carrier, bytes, { mode: 0o600 });
		const handed = join(root, "handed.bin");
		expect(await runOp(peer, "fs.write", { path: handed, bytes_path: carrier }, { root })).toEqual(
			applied({ path: handed, writtenBytes: bytes.byteLength }),
		);
		expect(
			createHash("sha256")
				.update(await readFile(handed))
				.digest("hex"),
		).toBe(digest);
		expect(existsSync(carrier)).toBe(false);
		const range = join(dirname(carrier), "range.bin");
		await writeFile(range, "XY", { mode: 0o600 });
		expect(
			await runOp(peer, "fs.write_range", { path: handed, offset: 1, bytes_path: range, total: 4 }, { root }),
		).toEqual(applied({ path: handed, writtenBytes: 2 }));
		expect((await readFile(handed)).subarray(0, 4)).toEqual(
			Buffer.concat([bytes.subarray(0, 1), Buffer.from("XY"), bytes.subarray(3, 4)]),
		);
		expect(existsSync(range)).toBe(false);
	});

	it("refuses a handed-over file that is not a private regular file in a private directory, and leaves it in place", async () => {
		const carriers = await privateDir("refused-carriers");
		const wideMode = join(carriers, "wide-mode.bin");
		await writeFile(wideMode, "x", { mode: 0o644 });
		const target = join(carriers, "target.bin");
		await writeFile(target, "x", { mode: 0o600 });
		const link = join(carriers, "link.bin");
		await symlink(target, link);
		const openDir = join(host.scratch, "open-carriers");
		await mkdir(openDir, { mode: 0o755 });
		await chmod(openDir, 0o755);
		const inOpenDir = join(openDir, "carrier.bin");
		await writeFile(inOpenDir, "x", { mode: 0o600 });
		const written = join(root, "never.bin");
		for (const handed of [wideMode, link, inOpenDir]) {
			expect(await runOp(peer, "fs.write", { path: written, bytes_path: handed }, { root }), handed).toEqual(
				outcome({
					state: "refused",
					error: {
						code: "malformed",
						message: `bytes_path ${handed} must be a 0600 regular file this user owns, in a 0700 directory this user owns`,
					},
				}),
			);
			expect(existsSync(handed), handed).toBe(true);
		}
		expect(existsSync(target)).toBe(true);
		expect(existsSync(written)).toBe(false);
	});
});
