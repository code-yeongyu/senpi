import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

describe("4351 resolution-chain review fold", () => {
	let root: string;
	let cwd: string;
	let outside: string;
	const registry = createBuiltinParserRegistry();
	const linkType = process.platform === "win32" ? "junction" : "dir";
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
	const fence = (input: string, service: PermissionService) => {
		const session = {};
		registerDispatchAuthorizer(
			session,
			createDispatchAuthorizer(
				{ getAllTools: () => [] },
				() => ({ service, parsers: registry, preset: "workspace", setupError: null }),
				async () => {
					throw new Error("Unexpected prompt");
				},
			),
		);
		return authorizeToolDispatch(
			session,
			{ toolName: "read", toolCallId: "chain", input: { path: input }, identity: { owner: registry, metadata: "" } },
			{ cwd, sessionManager: { getSessionId: () => "chain" } } as ExtensionContext,
			undefined,
		);
	};

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-chain-")));
		cwd = join(root, "project");
		outside = join(root, "outside");
		mkdirSync(cwd);
		mkdirSync(outside);
		writeFileSync(join(outside, "f.txt"), "fixture");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each([1, 2])("denies the direct spelling and a %i-hop prefix alias", async (hops) => {
		const a = join(root, "a");
		mkdirSync(join(a, "x"), { recursive: true });
		symlinkSync(outside, join(a, "x", "secret"), linkType);
		symlinkSync(a, join(root, "b"), linkType);
		if (hops === 2) symlinkSync(join(root, "b"), join(root, "c"), linkType);
		const service = new PermissionService([rule("*", "allow"), rule(`${a}/*/secret/*`, "deny")], []);
		for (const prefix of [a, join(root, hops === 1 ? "b" : "c")]) {
			const request = external(join(prefix, "x", "secret", "f.txt"));
			expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("deny");
			await expect(service.ask({ ...request, sessionID: "chain", metadata: {} }, request)).rejects.toMatchObject({
				_tag: "PermissionDeniedError",
			});
			await expect(fence(join(prefix, "x", "secret", "f.txt"), service)).rejects.toMatchObject({
				_tag: "PermissionDeniedError",
			});
		}
	});

	it("retains an earlier link while resolving a later relative link", () => {
		mkdirSync(join(root, "a", "x"), { recursive: true });
		symlinkSync(join(root, "a"), join(root, "b"), linkType);
		symlinkSync(outside, join(root, "a", "x", "secret"), linkType);
		symlinkSync("x", join(root, "a", "y"), "dir");
		const request = external(join(root, "b", "y", "secret", "f.txt"));
		const service = new PermissionService([rule("*", "allow"), rule(`${root}/b/x/secret/*`, "deny")], []);
		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("deny");
	});

	// senpi#4351: dot components in link targets must not hide intermediate denies.
	it.each([
		["tmp", "../proj"],
		[".", "./proj"],
		["tmp/nested", "../../proj"],
	])("denies an intermediate spelling through %s/link -> %s", async (directory, target) => {
		const project = join(root, "proj");
		const parent = join(root, directory);
		mkdirSync(join(project, "x"), { recursive: true });
		mkdirSync(parent, { recursive: true });
		symlinkSync(outside, join(project, "x", "secret"), linkType);
		symlinkSync(target, join(parent, "link"), "dir");
		const input = join(parent, "link", "x", "secret", "f.txt");
		const request = external(input);
		const service = new PermissionService([rule("*", "allow"), rule(`${project}/*/secret/*`, "deny")], []);

		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("deny");
		await expect(service.ask({ ...request, sessionID: "dots", metadata: {} }, request)).rejects.toMatchObject({
			_tag: "PermissionDeniedError",
		});
		await expect(fence(input, service)).rejects.toMatchObject({ _tag: "PermissionDeniedError" });
	});

	it.each([
		["loop", 2],
		["hop-limit", 41],
	] as const)("asks instead of allowing a %s", (kind, count) => {
		for (let index = 0; index < count; index++) {
			const destination =
				index + 1 === count ? (kind === "loop" ? join(root, "link0") : outside) : join(root, `link${index + 1}`);
			symlinkSync(destination, join(root, `link${index}`), linkType);
		}
		const request = external(join(root, "link0", "f.txt"));
		const service = new PermissionService([rule("*", "allow")], [rule("*", "allow")]);
		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("ask");
	});

	it.each([
		[4, "allow"],
		[5, "allow"],
		[15, "allow"],
		[16, "ask"],
	] as const)("bounds %i independent links at sixteen spellings", (count, expected) => {
		let parent = root;
		const input: string[] = [];
		for (let index = 0; index < count; index++) {
			mkdirSync(join(parent, `dir${index}`));
			symlinkSync(`dir${index}`, join(parent, `link${index}`), "dir");
			input.push(`link${index}`);
			parent = join(parent, `dir${index}`);
		}
		writeFileSync(join(parent, "f.txt"), "fixture");
		const request = external(join(root, ...input, "f.txt"));
		const service = new PermissionService([rule("*", "allow")], []);
		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe(expected);
	});

	for (const action of ["deny", "allow"] as const) {
		// Windows chmod does not implement POSIX directory search/list permission bits.
		it.skipIf(process.platform === "win32")(
			`keeps a metadata-proven case ${action} below a non-listable ancestor`,
			async (context) => {
				const locked = join(root, "Locked");
				const data = join(locked, "Data");
				mkdirSync(locked, { mode: 0o711 });
				mkdirSync(join(data, "x"), { recursive: true });
				writeFileSync(join(data, "f.txt"), "fixture");
				symlinkSync(outside, join(data, "x", "secret"), linkType);
				try {
					const actual = statSync(data, { bigint: true });
					const alias = statSync(join(locked, "DATA"), { bigint: true });
					if (actual.dev !== alias.dev || actual.ino !== alias.ino) return context.skip();
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
					return context.skip();
				}
				// 0711 is still listable by its owner; remove owner read too for this process.
				chmodSync(locked, 0o111);
				try {
					expect(() => readdirSync(locked)).toThrow();
					const input =
						action === "deny"
							? join(data, "x", "secret", "f.txt")
							: join(root.toUpperCase(), "Locked", "DATA", "f.txt");
					const pattern = action === "deny" ? `${locked}/DATA/*/secret/*` : `${data}/*`;
					const service = new PermissionService(
						[
							{ permission: "*", pattern: "*", action: "allow" },
							rule("*", action === "deny" ? "allow" : "deny"),
							rule(pattern, action),
						],
						[],
					);
					const request = external(input);
					expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe(action);
					if (action === "deny") {
						await expect(fence(input, service)).rejects.toMatchObject({ _tag: "PermissionDeniedError" });
					} else {
						expect((await fence(input, service))()).toBe(true);
					}
				} finally {
					chmodSync(locked, 0o711);
				}
			},
		);
	}

	it("does not report an allowed sibling as denied by another path's alias", async () => {
		mkdirSync(join(root, "a", "x"), { recursive: true });
		symlinkSync(outside, join(root, "a", "x", "secret"), linkType);
		const denied = external(join(root, "a", "x", "secret", "f.txt"));
		const allowed = join(root, "allowed.txt");
		writeFileSync(allowed, "fixture");
		const service = new PermissionService([rule("*", "allow"), rule(`${root}/a/*/secret/*`, "deny")], []);
		await expect(
			service.ask(
				{ ...denied, patterns: [...denied.patterns, allowed], sessionID: "siblings", metadata: {} },
				denied,
			),
		).rejects.toMatchObject({ patterns: denied.patterns });
	});
});
