import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A finishing mover removes the emptied `session-holders/<id>` directory. Node's recursive mkdir reports EEXIST
// for a directory another process just created, stats it to confirm, and fails with ENOENT when the stat lands
// after that removal (`MKDirpAsync`/`MKDirpSync` in node_file.cc). The window sits inside one native call, so the
// hooks below run the other process's whole lifetime at the mkdir of the lock directory and then return the error
// node returns for that interleaving: the race is reproduced exactly once instead of hoping two processes collide.
const fsHooks = vi.hoisted(() => ({
	dir: "",
	asyncMkdirs: 0,
	onAsyncMkdir: undefined as (() => Promise<void>) | undefined,
	onSyncMkdir: undefined as (() => void) | undefined,
}));

function mkdirEnoent(path: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), {
		errno: -2,
		code: "ENOENT",
		syscall: "mkdir",
		path,
	});
}

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const mkdir = (async (path: Parameters<typeof actual.mkdir>[0], ...rest: unknown[]) => {
		if (path === fsHooks.dir) fsHooks.asyncMkdirs += 1;
		// Stops an unbounded retry deterministically: an error the lock code never tolerates ends the loop.
		if (path === fsHooks.dir && fsHooks.asyncMkdirs > 4)
			throw new Error("lock-directory mkdir retried without bound");
		const hook = fsHooks.onAsyncMkdir;
		if (hook !== undefined && path === fsHooks.dir) {
			fsHooks.onAsyncMkdir = undefined;
			await hook();
			throw mkdirEnoent(path);
		}
		return Reflect.apply(actual.mkdir, actual, [path, ...rest]);
	}) as typeof actual.mkdir;
	return { ...actual, default: { ...actual, mkdir }, mkdir };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const mkdirSync = ((path: Parameters<typeof actual.mkdirSync>[0], ...rest: unknown[]) => {
		const hook = fsHooks.onSyncMkdir;
		if (hook !== undefined && path === fsHooks.dir) {
			fsHooks.onSyncMkdir = undefined;
			hook();
			throw mkdirEnoent(path);
		}
		return Reflect.apply(actual.mkdirSync, actual, [path, ...rest]);
	}) as typeof actual.mkdirSync;
	return { ...actual, default: { ...actual, mkdirSync }, mkdirSync };
});

const { rebindSessionFile } = await import("../../../src/core/session-rebind.ts");
const { holdSessionFile, withSessionMoveLock } = await import("../../../src/core/session-holders.ts");
const { encodedSessionId } = await import("../../../src/core/session-sidecar-store.ts");

const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
const roots: string[] = [];
afterEach(() => {
	fsHooks.onAsyncMkdir = undefined;
	fsHooks.onSyncMkdir = undefined;
	fsHooks.asyncMkdirs = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session() {
	const root = mkdtempSync(join(tmpdir(), "senpi-5618-"));
	roots.push(root);
	const oldDir = join(root, "old");
	const newDir = join(root, "new");
	mkdirSync(oldDir, { recursive: true });
	const name = `2026-11-03T00-00-00-000Z_${SESSION_ID}.jsonl`;
	const source = join(oldDir, name);
	const body = '{"type":"message","id":"m1"}\n';
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: SESSION_ID, cwd: join(root, "old-repo") })}\n${body}`,
	);
	fsHooks.dir = join(oldDir, "session-holders", encodedSessionId(SESSION_ID));
	return { root, source, target: join(newDir, name), newDir, cwd: join(root, "new-repo"), body };
}

describe("issue #5618 move-lock directory removed by a finishing mover", () => {
	it("a rebind whose lock-directory mkdir loses that race converges on the other rebind's target", async () => {
		const { source, target, newDir, cwd, body } = session();
		let concurrent: string | undefined;
		fsHooks.onAsyncMkdir = async () => {
			concurrent = await rebindSessionFile(source, cwd, newDir);
		};

		await expect(rebindSessionFile(source, cwd, newDir)).resolves.toBe(target);
		expect(concurrent).toBe(target);
		expect(existsSync(source)).toBe(false);
		const [header, ...rest] = readFileSync(target, "utf8").split("\n");
		expect(JSON.parse(header ?? "{}").cwd).toBe(cwd);
		expect(rest.join("\n")).toBe(body);
		expect(readdirSync(newDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(existsSync(fsHooks.dir)).toBe(false);
	});

	it("a lock directory that can never be created (dangling symlink) still fails fast with ENOENT", async () => {
		const { source, root } = session();
		mkdirSync(dirname(fsHooks.dir), { recursive: true });
		symlinkSync(join(root, "missing"), fsHooks.dir);
		const move = vi.fn(() => "moved");

		await expect(withSessionMoveLock(source, SESSION_ID, move, { waitMs: 200 })).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(move).not.toHaveBeenCalled();
		expect(fsHooks.asyncMkdirs).toBe(2);
	});

	it("a holder whose record-directory mkdir loses that race still publishes its record", async () => {
		const { source } = session();
		fsHooks.onSyncMkdir = () => {
			mkdirSync(fsHooks.dir, { recursive: true });
			rmdirSync(fsHooks.dir);
		};

		const hold = await holdSessionFile(source, SESSION_ID, { expectExisting: true });
		expect(existsSync(join(fsHooks.dir, `${process.pid}.json`))).toBe(true);
		hold.release();
		expect(existsSync(fsHooks.dir)).toBe(false);
	});
});
