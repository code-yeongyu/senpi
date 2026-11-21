import { vi } from "vitest";

const filesystem = vi.hoisted(() => ({
	root: "",
	wedged: "",
	opened: [] as string[],
	entries: new Map<string, { ino: number; kind: "directory" | "file" }>(),
}));

// A case-sensitive in-memory tree under a temp root, with one directory whose open never returns on a real host (the
// macOS /home autofs trigger, a stuck FUSE or NFS mount). lstat below it answers; listing it is recorded and refused.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const { dirname, basename, sep } = await import("node:path");
	const owns = (path: string) => filesystem.root !== "" && path.startsWith(`${filesystem.root}${sep}`);
	const metadata = (path: string, bigint = false) => {
		const entry = filesystem.entries.get(path);
		if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		return {
			...actual.statSync(filesystem.root),
			dev: bigint ? 1n : 1,
			ino: bigint ? BigInt(entry.ino) : entry.ino,
			isDirectory: () => entry.kind === "directory",
			isFile: () => entry.kind === "file",
			isSymbolicLink: () => false,
		};
	};
	const mocked = {
		lstatSync: (path: string, options?: { bigint?: boolean }) =>
			owns(String(path)) ? metadata(String(path), options?.bigint) : actual.lstatSync(path, options),
		statSync: (path: string, options?: { bigint?: boolean }) =>
			owns(String(path)) ? metadata(String(path), options?.bigint) : actual.statSync(path, options),
		readdirSync: (path: string) => {
			if (String(path) === filesystem.wedged) {
				filesystem.opened.push(String(path));
				throw Object.assign(new Error(`EWEDGED: opening ${path} would block`), { code: "EWEDGED" });
			}
			if (String(path) !== filesystem.root && !owns(String(path))) return actual.readdirSync(path);
			return [...filesystem.entries.keys()]
				.filter((entry) => dirname(entry) === String(path))
				.map((entry) => basename(entry));
		},
	};
	return { ...actual, ...mocked, default: { ...actual, ...mocked } };
});

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";

// senpi#7150: the external_directory decision runs on the engine's main thread, so a directory it opens on a wedged
// mount freezes the whole engine. Case recovery may list a directory only when that can change the spelling.
describe("7150 external_directory case recovery on a wedged mount", () => {
	beforeEach(() => {
		filesystem.root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-wedged-")));
		const root = filesystem.root;
		filesystem.wedged = join(root, "wedged");
		filesystem.opened = [];
		filesystem.entries = new Map([
			[join(root, "workspace"), { ino: 11, kind: "directory" }],
			[join(root, "wedged"), { ino: 12, kind: "directory" }],
			[join(root, "wedged", "present"), { ino: 13, kind: "directory" }],
			[join(root, "wedged", "present", "f.txt"), { ino: 14, kind: "file" }],
		]);
	});
	afterEach(() => {
		const root = filesystem.root;
		filesystem.root = "";
		filesystem.wedged = "";
		filesystem.entries.clear();
		rmSync(root, { recursive: true, force: true });
	});

	const rule = (pattern: string, action: Rule["action"]): Rule => ({ permission: "external_directory", pattern, action });

	it.each([
		{ name: "a missing path below it", below: ["missing", "f.txt"], deny: false, expected: "allow" },
		{ name: "a case-exact existing path below it", below: ["present", "f.txt"], deny: false, expected: "allow" },
		{ name: "a missing path under a deny rule for it", below: ["missing", "f.txt"], deny: true, expected: "deny" },
	] as const)("decides $name without opening the wedged directory", ({ below, deny, expected }) => {
		const root = filesystem.root;
		const service = new PermissionService(
			[
				{ permission: "*", pattern: "*", action: "allow" },
				...(deny ? [rule(`${filesystem.wedged}/*`, "deny")] : []),
			],
			[],
		);
		const request = createBuiltinParserRegistry()
			.parse("read", { path: join(filesystem.wedged, ...below) }, join(root, "workspace"))
			.find((item) => item.permission === "external_directory");
		if (!request) throw new Error("Missing external-directory request");

		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe(expected);
		expect(filesystem.opened).toEqual([]);
	});
});
