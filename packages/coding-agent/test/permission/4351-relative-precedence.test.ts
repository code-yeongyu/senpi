import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Ruleset } from "../../src/core/extensions/builtin/permission-system/types.ts";

describe("4351 relative-target precedence", () => {
	let root: string;
	let cwd: string;
	let outside: string;
	const registry = createBuiltinParserRegistry();

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-relative-")));
		cwd = join(root, "workspace");
		outside = join(root, "outside");
		mkdirSync(cwd);
		mkdirSync(outside);
		mkdirSync(join(root, "proj", "x"), { recursive: true });
		writeFileSync(join(outside, "f.txt"), "fixture");
		symlinkSync("../../outside", join(root, "proj", "x", "secret"), "dir");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const external = (path: string) => {
		const request = registry.parse("read", { path }, cwd).find((r) => r.permission === "external_directory");
		if (!request) throw new Error("Missing external request");
		return request;
	};

	// senpi#4351 LOW N1: the absolute-target matrix also holds for a ../../ target.
	it.each([
		["allow", "allow", "allow"],
		["allow", "ask", "ask"],
		["allow", "deny", "deny"],
		["ask", "allow", "ask"],
		["ask", "ask", "ask"],
		["ask", "deny", "deny"],
		["deny", "allow", "deny"],
		["deny", "ask", "deny"],
		["deny", "deny", "deny"],
	] as const)("combines relative lexical %s and resolved %s as %s", (lexical, resolved, expected) => {
		const request = external(join(root, "proj", "x", "secret", "f.txt"));
		const rules: Ruleset = [
			{ permission: "external_directory", pattern: `${root}/proj/*/secret/*`, action: lexical },
			{ permission: "external_directory", pattern: `${outside}/*`, action: resolved },
		];
		for (const ordered of [rules, [...rules].reverse()]) {
			const service = new PermissionService(
				[{ permission: "external_directory", pattern: "*", action: "deny" }, ...ordered],
				[],
			);
			expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe(expected);
		}
	});

	it.each([false, true])("keeps an intermediate blanket deny when both endpoints allow, reversed=%s", (reversed) => {
		mkdirSync(join(root, "tmp"));
		symlinkSync("../proj", join(root, "tmp", "entry"), "dir");
		const request = external(join(root, "tmp", "entry", "x", "secret", "f.txt"));
		const allows: Ruleset = [
			{ permission: "external_directory", pattern: `${root}/tmp/entry/*`, action: "allow" },
			{ permission: "external_directory", pattern: `${outside}/*`, action: "allow" },
		];
		const service = new PermissionService(
			[
				{ permission: "external_directory", pattern: "*", action: "deny" },
				...(reversed ? [...allows].reverse() : allows),
			],
			[],
		);

		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("deny");
	});
});
