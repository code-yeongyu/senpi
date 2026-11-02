import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A realpath can hang (a stalled network mount). Each gate held for a path is taken by the next realpath of that path,
// in order, and keeps it open until the test releases it; a gated call then answers without disk I/O, so which call
// settles first depends only on release order. A call with no gate left runs the real realpath.
const hooks = vi.hoisted(() => ({ gates: new Map<string, Promise<void>[]>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const realpath = (async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
		const gate = hooks.gates.get(String(path))?.shift();
		if (gate !== undefined) {
			await gate;
			return String(path);
		}
		return Reflect.apply(actual.realpath, actual, [path, ...rest]);
	}) as typeof actual.realpath;
	return { ...actual, default: { ...actual, realpath }, realpath };
});

const { orderedRealPath } = await import("../../src/core/session-move/session-lock.ts");

const roots: string[] = [];
afterEach(() => {
	hooks.gates.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionFiles(): { readonly a: string; readonly b: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-move-key-order-"));
	roots.push(root);
	const a = join(root, "a.jsonl");
	const b = join(root, "b.jsonl");
	writeFileSync(a, "");
	writeFileSync(b, "");
	return { a, b };
}

/** Holds the next not-yet-held realpath of `path` open; returns its release. */
function hold(path: string): () => void {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	hooks.gates.set(path, [...(hooks.gates.get(path) ?? []), gate]);
	return release;
}

describe("move lock keys resolve in call order per file, independently across files", () => {
	it("resolves another file's key while one file's realpath hangs", async () => {
		// Given file a whose realpath hangs
		const { a, b } = sessionFiles();
		const release = hold(a);
		let aSettled = false;
		const pendingA = orderedRealPath(a).then((path) => {
			aSettled = true;
			return path;
		});
		// When file b's key is resolved
		const resolvedB = await orderedRealPath(b);
		// Then b resolves without waiting for a, and a resolves once its realpath returns
		expect(resolvedB).toBe(realpathSync(b));
		expect(aSettled).toBe(false);
		release();
		expect(await pendingA).toBe(a);
	});

	it("keeps call order for one file even when the later call's realpath answers first", async () => {
		// Given two resolutions of the same file, each realpath held open
		const { a } = sessionFiles();
		const releaseFirst = hold(a);
		const releaseSecond = hold(a);
		const order: number[] = [];
		const first = orderedRealPath(a).then(() => order.push(1));
		const second = orderedRealPath(a).then(() => order.push(2));
		// When the second realpath is released before the first
		releaseSecond();
		releaseFirst();
		await Promise.all([first, second]);
		// Then the second still waited for the first: they settled in call order
		expect(order).toEqual([1, 2]);
	});
});
