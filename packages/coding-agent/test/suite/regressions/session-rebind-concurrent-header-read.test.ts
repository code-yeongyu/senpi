import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The window under test: `rebindSessionFile` checks the source exists, then reads its header before taking the move lock.
// A concurrent rebind can finish the move in between. `onSourceRead` runs exactly at that read, so each case reproduces
// the race deterministically instead of hoping two processes collide.
const fsHooks = vi.hoisted(() => ({ onSourceRead: undefined as ((path: string) => void) | undefined, source: "" }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
		const hook = fsHooks.onSourceRead;
		if (hook !== undefined && path === fsHooks.source) {
			fsHooks.onSourceRead = undefined;
			hook(path);
		}
		return Reflect.apply(actual.readFileSync, actual, [path, ...rest]);
	}) as typeof actual.readFileSync;
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { rebindSessionFile } = await import("../../../src/core/session-rebind.ts");

const roots: string[] = [];
afterEach(() => {
	fsHooks.onSourceRead = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session() {
	const root = mkdtempSync(join(tmpdir(), "senpi-rebind-race-"));
	roots.push(root);
	const oldDir = join(root, "old");
	const newDir = join(root, "new");
	mkdirSync(oldDir, { recursive: true });
	const name = "2026-10-06T00-00-00-000Z_0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3.jsonl";
	const source = join(oldDir, name);
	const target = join(newDir, name);
	const body = '{"type":"message","id":"m1"}\n';
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3", cwd: join(root, "old-repo") })}\n${body}`,
	);
	fsHooks.source = source;
	return { root, source, target, newDir, cwd: join(root, "new-repo"), body };
}

describe("rebindSessionFile when a concurrent rebind finishes the move before the header is read", () => {
	it("returns the target the other process already moved the session to", async () => {
		const { source, target, newDir, cwd, body } = session();
		fsHooks.onSourceRead = () => {
			mkdirSync(newDir, { recursive: true });
			writeFileSync(
				target,
				`${JSON.stringify({ type: "session", id: "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3", cwd })}\n${body}`,
			);
			rmSync(source);
		};

		await expect(rebindSessionFile(source, cwd, newDir)).resolves.toBe(target);
		expect(existsSync(source)).toBe(false);
		const [header, ...rest] = readFileSync(target, "utf8").split("\n");
		expect(JSON.parse(header ?? "{}").cwd).toBe(cwd);
		expect(rest.join("\n")).toBe(body);
	});

	it("still fails when the source vanished and nothing was moved to the target", async () => {
		const { source, newDir, cwd } = session();
		fsHooks.onSourceRead = () => rmSync(source);

		await expect(rebindSessionFile(source, cwd, newDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("still fails on any other read error even when the target exists", async () => {
		const { source, target, newDir, cwd } = session();
		fsHooks.onSourceRead = () => {
			mkdirSync(newDir, { recursive: true });
			writeFileSync(target, "occupied\n");
			renameSync(source, `${source}.moved`);
			mkdirSync(source);
		};

		await expect(rebindSessionFile(source, cwd, newDir)).rejects.toMatchObject({ code: "EISDIR" });
	});
});
