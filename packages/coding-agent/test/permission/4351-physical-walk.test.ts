import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";

describe("4351 physical component walk", () => {
	let root: string;
	let cwd: string;
	let outside: string;
	const registry = createBuiltinParserRegistry();
	const rule = (pattern: string, action: Rule["action"]): Rule => ({
		permission: "external_directory",
		pattern,
		action,
	});
	const external = (input: string) => {
		const request = registry.parse("read", { path: input }, cwd).find((r) => r.permission === "external_directory");
		if (!request) throw new Error("Missing external request");
		return request;
	};

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-physical-")));
		cwd = join(root, "workspace");
		outside = join(root, "outside");
		mkdirSync(cwd);
		mkdirSync(outside);
		writeFileSync(join(outside, "f.txt"), "fixture");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	// senpi#4351 HIGH: resolving S before .. must expose the denied p/y route.
	it.each([
		["absolute", "y"],
		["relative", "y"],
		["absolute", "?"],
		["relative", "?"],
	])("denies a physical parent in an %s link target with p/%s/*", (kind, denied) => {
		mkdirSync(join(root, "a"));
		mkdirSync(join(root, "x"));
		mkdirSync(join(root, "p", "q"), { recursive: true });
		symlinkSync(join(root, "p", "q"), join(root, "x", "S"), "dir");
		symlinkSync(outside, join(root, "p", "y"), "dir");
		symlinkSync(kind === "absolute" ? `${root}/x/S/../y` : "../x/S/../y", join(root, "a", "L"), "dir");
		const service = new PermissionService([rule("*", "allow"), rule(`${root}/p/${denied}/*`, "deny")], []);
		for (const input of [join(root, "p", "y", "f.txt"), join(root, "a", "L", "f.txt")]) {
			expect(realpathSync.native(input)).toBe(join(outside, "f.txt"));
			const request = external(input);
			expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("deny");
		}
	});

	// senpi#4351 MEDIUM: L2 is relative to physical b/c, never lexical a/L1.
	it("allows a relative link without inventing an unresolved-parent spelling", () => {
		mkdirSync(join(root, "a", "d"), { recursive: true });
		mkdirSync(join(root, "b", "c"), { recursive: true });
		mkdirSync(join(root, "b", "d"));
		writeFileSync(join(root, "b", "d", "f.txt"), "fixture");
		symlinkSync(join(root, "b", "c"), join(root, "a", "L1"), "dir");
		symlinkSync("../d", join(root, "b", "c", "L2"), "dir");
		const input = join(root, "a", "L1", "L2", "f.txt");
		expect(realpathSync.native(input)).toBe(join(root, "b", "d", "f.txt"));
		const request = external(input);
		const service = new PermissionService([rule("*", "allow"), rule(`${root}/a/d/*`, "deny")], []);
		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("allow");
	});
});
