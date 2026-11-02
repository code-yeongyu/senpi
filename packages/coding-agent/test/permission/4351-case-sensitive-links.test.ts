import { vi } from "vitest";

const filesystem = vi.hoisted(() => ({
	root: "",
	entries: new Map<string, { ino: number; kind: "directory" | "file" | "symlink"; target?: string }>(),
}));

// The review's metadata seam models distinct case-sensitive entries on any host volume.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const { dirname, basename, sep } = await import("node:path");
	const owns = (path: string) => filesystem.root !== "" && path.startsWith(`${filesystem.root}${sep}`);
	const lookup = (path: string, followFinal: boolean) => {
		for (const [link, entry] of filesystem.entries) {
			if (entry.target && (path.startsWith(`${link}${sep}`) || (followFinal && path === link))) {
				path = entry.target + path.slice(link.length);
				break;
			}
		}
		const entry = filesystem.entries.get(path);
		if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		return entry;
	};
	const metadata = (path: string, followFinal: boolean, bigint = false) => {
		const entry = lookup(path, followFinal);
		return {
			...actual.statSync(filesystem.root),
			dev: bigint ? 1n : 1,
			ino: bigint ? BigInt(entry.ino) : entry.ino,
			isDirectory: () => entry.kind === "directory",
			isFile: () => entry.kind === "file",
			isSymbolicLink: () => entry.kind === "symlink",
		};
	};
	const mocked = {
		lstatSync: (path: string, options?: { bigint?: boolean }) =>
			owns(String(path)) ? metadata(String(path), false, options?.bigint) : actual.lstatSync(path, options),
		statSync: (path: string, options?: { bigint?: boolean }) =>
			owns(String(path)) ? metadata(String(path), true, options?.bigint) : actual.statSync(path, options),
		readlinkSync: (path: string) => {
			if (!owns(String(path))) return actual.readlinkSync(path);
			const target = lookup(String(path), false).target;
			if (!target) throw Object.assign(new Error(`EINVAL: ${path}`), { code: "EINVAL" });
			return target;
		},
		readdirSync: (path: string) => {
			if (String(path) !== filesystem.root && !owns(String(path))) return actual.readdirSync(path);
			return [...filesystem.entries.keys()]
				.filter((entry) => dirname(entry) === String(path))
				.map((entry) => basename(entry));
		},
	};
	return { ...actual, ...mocked, default: { ...actual, ...mocked } };
});

import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	authorizeToolDispatch,
	registerDispatchAuthorizer,
} from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { createDispatchAuthorizer } from "../../src/core/extensions/builtin/permission-system/dispatch-policy.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

describe("4351 distinct case-sensitive symlink entries", () => {
	beforeEach(() => {
		filesystem.root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-link-case-")));
		const root = filesystem.root;
		filesystem.entries = new Map([
			[join(root, "workspace"), { ino: 11, kind: "directory" }],
			[join(root, "routes"), { ino: 12, kind: "directory" }],
			[join(root, "outside"), { ino: 13, kind: "directory" }],
			[join(root, "outside", "f.txt"), { ino: 14, kind: "file" }],
			[join(root, "routes", "A"), { ino: 15, kind: "symlink", target: join(root, "outside") }],
			[join(root, "routes", "a"), { ino: 16, kind: "symlink", target: join(root, "outside") }],
		]);
	});
	afterEach(() => {
		const root = filesystem.root;
		filesystem.root = "";
		filesystem.entries.clear();
		rmSync(root, { recursive: true, force: true });
	});

	// #4351 / #4311: a later rule for another entry cannot override a deny or create a false deny.
	it.each([
		{ name: "deny bypass", denyLowercase: true, uppercaseAction: "allow", expected: "deny" },
		{ name: "unrelated deny", denyLowercase: false, uppercaseAction: "deny", expected: "allow" },
	] as const)("$name", async ({ denyLowercase, uppercaseAction, expected }) => {
		const root = filesystem.root;
		const lower = join(root, "routes", "a");
		const upper = join(root, "routes", "A");
		expect(readdirSync(join(root, "routes"))).toEqual(["A", "a"]);
		expect(lstatSync(lower).ino).not.toBe(lstatSync(upper).ino);
		expect(statSync(lower).ino).toBe(statSync(upper).ino);
		const rule = (pattern: string, action: Rule["action"]): Rule => ({
			permission: "external_directory",
			pattern,
			action,
		});
		const service = new PermissionService(
			[
				{ permission: "*", pattern: "*", action: "allow" },
				...(denyLowercase ? [rule(`${root}/*/a/*`, "deny")] : []),
				rule(`${root}/*/A/*`, uppercaseAction),
			],
			[],
		);
		const registry = createBuiltinParserRegistry();
		const input = { path: join(lower, "f.txt") };
		const cwd = join(root, "workspace");
		const request = registry.parse("read", input, cwd).find((item) => item.permission === "external_directory");
		if (!request) throw new Error("Missing external-directory request");
		expect(request.patterns).toEqual([join(root, "outside", "f.txt")]);
		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe(expected);

		const session = {};
		const authorizer = createDispatchAuthorizer(
			{ getAllTools: () => [] },
			() => ({ service, parsers: registry, preset: "workspace", setupError: null }),
			async () => {
				throw new Error("Unexpected prompt");
			},
		);
		registerDispatchAuthorizer(session, authorizer);
		const invocation = {
			toolName: "read",
			toolCallId: "case-sensitive-links",
			input,
			identity: { owner: registry, metadata: "" },
		};
		const context = { cwd, sessionManager: { getSessionId: () => "case-sensitive-links" } } as ExtensionContext;
		expect(authorizer.policy(invocation, context).action).toBe(expected);
		const fence = authorizeToolDispatch(session, invocation, context, undefined);
		if (expected === "deny") {
			await expect(fence).rejects.toMatchObject({ _tag: "PermissionDeniedError" });
		} else {
			expect((await fence)?.()).toBe(true);
		}
	});
});
