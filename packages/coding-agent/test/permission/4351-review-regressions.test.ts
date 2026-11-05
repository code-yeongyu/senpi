import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { createDispatchAuthorizer } from "../../src/core/extensions/builtin/permission-system/dispatch-policy.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { appendApproved, loadApproved } from "../../src/core/extensions/builtin/permission-system/storage.ts";
import type { Ruleset } from "../../src/core/extensions/builtin/permission-system/types.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

describe("4351 binding review regressions", () => {
	let root: string;
	let cwd: string;
	let outside: string;
	const registry = createBuiltinParserRegistry();

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-4351-")));
		cwd = join(root, "project");
		outside = join(root, "Outside");
		mkdirSync(cwd);
		mkdirSync(outside);
		writeFileSync(join(outside, "File.txt"), "fixture");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const external = (tool: string, input: Record<string, unknown>, cwd: string) => {
		const request = registry.parse(tool, input, cwd).find((item) => item.permission === "external_directory");
		if (!request) throw new Error("Missing external-directory request");
		return request;
	};

	it("lets a later shared-directory allow override a blanket deny for every spelling", async () => {
		const shared = join(root, "shared");
		mkdirSync(shared);
		const target = join(shared, "f.txt");
		writeFileSync(target, "fixture");
		const service = new PermissionService(
			[
				{ permission: "external_directory", pattern: "*", action: "deny" },
				{ permission: "external_directory", pattern: `${shared}/*`, action: "allow" },
			],
			[],
		);
		for (const inputPath of [target, relative(cwd, target)]) {
			const request = external("write", { path: inputPath }, cwd);
			expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("allow");
			await expect(
				service.ask({ ...request, sessionID: "precedence", metadata: {} }, request),
			).resolves.toBeUndefined();
		}
	});

	for (const variant of ["rule-case", "input-case", "prefix-case", "suffix-case"]) {
		for (const allowTarget of [false, true]) {
			it(`retains lexical ancestry for ${variant} with target allow=${allowTarget}`, async (context) => {
				const modules = join(root, "node_modules");
				const scope = join(modules, "@earendil-works");
				mkdirSync(scope, { recursive: true });
				symlinkSync(outside, join(scope, "pi-ai"), process.platform === "win32" ? "junction" : "dir");
				writeFileSync(join(outside, "package.json"), "{}");
				const lexical = join(scope, "pi-ai", "package.json");
				try {
					const actual = statSync(lexical, { bigint: true });
					const alias = statSync(join(root, "NODE_MODULES", "@earendil-works", "PI-AI", "PACKAGE.JSON"), {
						bigint: true,
					});
					if (actual.dev !== alias.dev || actual.ino !== alias.ino) return context.skip();
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					return context.skip();
				}
				const pattern =
					variant === "rule-case"
						? `${modules}/*/PI-AI/*`
						: variant === "prefix-case"
							? `${root}/NODE_MODULES/*/pi-ai/*`
							: variant === "suffix-case"
								? `${modules}/*/pi-ai/*.JSON`
								: `${modules}/*/pi-ai/*`;
				const input = { path: variant === "input-case" ? join(scope, "PI-AI", "package.json") : lexical };
				const request = external("read", input, cwd);
				const emitter = createLocalEventEmitter();
				const service = new PermissionService(
					[
						{ permission: "*", pattern: "*", action: "allow" },
						{ permission: "external_directory", pattern: "*", action: "ask" },
						{ permission: "external_directory", pattern, action: "deny" },
						...(allowTarget
							? [{ permission: "external_directory", pattern: `${outside}/*`, action: "allow" as const }]
							: []),
					],
					[],
					emitter,
				);
				emitter.onAsked((pending) => service.reply({ requestID: pending.id, reply: "once" }));
				await expect(
					service.ask({ ...request, sessionID: "case-symlink", metadata: {} }, request),
				).rejects.toMatchObject({ _tag: "PermissionDeniedError" });
				const authorizer = createDispatchAuthorizer(
					{ getAllTools: () => [] },
					() => ({ service, parsers: registry, preset: "workspace", setupError: null }),
					async () => undefined,
				);
				expect(
					authorizer.policy(
						{ toolName: "read", toolCallId: "case-symlink", input, identity: { owner: registry, metadata: "" } },
						{ cwd, sessionManager: { getSessionId: () => "case-symlink" } } as ExtensionContext,
					).action,
				).toBe("deny");
			});
		}
	}

	it("uses absolute rule aliases rather than raw relative display paths", () => {
		const request = external("write", { path: relative(cwd, join(outside, "File.txt")) }, cwd);
		const service = new PermissionService(
			[
				{ permission: "external_directory", pattern: "*", action: "allow" },
				{ permission: "external_directory", pattern: "../*", action: "deny" },
			],
			[],
		);
		expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("allow");
	});

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
	] as const)("combines lexical %s and resolved %s as %s regardless of rule order", (lexical, resolved, expected) => {
		const data = join(root, "data");
		mkdirSync(join(data, "a"), { recursive: true });
		symlinkSync(outside, join(data, "a", "secret"), process.platform === "win32" ? "junction" : "dir");
		const request = external("read", { path: join(data, "a", "secret", "File.txt") }, cwd);
		const rules: Ruleset = [
			{ permission: "external_directory", pattern: `${data}/*/secret/*`, action: lexical },
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

	// senpi#4351: a wildcard before a symlink must not erase a lexical deny.
	for (const tool of [
		"read",
		"write",
		"edit",
		"multiedit",
		"apply_patch",
		"grep",
		"ls",
		"find",
		"glob",
		"monitor",
		"bash",
		"bash_input",
	]) {
		for (const allowTarget of [false, true]) {
			it(`${tool} preserves a wildcard-before-symlink deny with target allow=${allowTarget}`, async () => {
				const data = join(root, "data");
				mkdirSync(join(data, "a"), { recursive: true });
				symlinkSync(outside, join(data, "a", "secret"), process.platform === "win32" ? "junction" : "dir");
				const lexical = join(data, "a", "secret", "File.txt");
				const rules: Ruleset = [
					{ permission: "*", pattern: "*", action: "allow" },
					{ permission: "external_directory", pattern: "*", action: "ask" },
					{ permission: "external_directory", pattern: `${data}/*/secret/*`, action: "deny" },
					...(allowTarget
						? [{ permission: "external_directory", pattern: `${outside}/*`, action: "allow" as const }]
						: []),
				];
				for (const path of [lexical, relative(cwd, lexical)]) {
					const input =
						tool === "bash"
							? { command: `cat "${path}"` }
							: tool === "bash_input"
								? { input: `cat "${path}"` }
								: { path };
					const request = external(tool, input, cwd);
					const emitter = createLocalEventEmitter();
					const service = new PermissionService(rules, [], emitter);
					// A missed deny resolves instead of leaving this regression waiting for a prompt.
					emitter.onAsked((pending) => service.reply({ requestID: pending.id, reply: "once" }));
					await expect(
						service.ask(
							{ ...request, sessionID: "wildcard-symlink", metadata: {} },
							{ ruleAliases: request.ruleAliases },
						),
					).rejects.toMatchObject({ _tag: "PermissionDeniedError" });
					const authorizer = createDispatchAuthorizer(
						{ getAllTools: () => [] },
						() => ({ service, parsers: registry, preset: "workspace", setupError: null }),
						async () => undefined,
					);
					const ctx = { cwd, sessionManager: { getSessionId: () => "wildcard-symlink" } } as ExtensionContext;
					expect(
						authorizer.policy(
							{
								toolName: tool,
								toolCallId: "wildcard",
								input,
								identity: { owner: registry, metadata: "wildcard" },
							},
							ctx,
						).action,
					).toBe("deny");
				}
			});
		}
	}

	// senpi#4316: de-duplicating by canonical target must keep the lexical alias of every spelling.
	const patch = (paths: readonly string[]) =>
		[
			"*** Begin Patch",
			...paths.flatMap((path) => [`*** Update File: ${path}`, "@@", "-fixture", "+x"]),
			"*** End Patch",
		].join("\n");
	const manyPathInputs: Record<string, (paths: readonly string[]) => Record<string, unknown>> = {
		bash: (paths) => ({ command: `cat ${paths.map((path) => `"${path}"`).join(" ")}` }),
		grep: (paths) => ({ pattern: "fixture", path: [...paths] }),
		multiedit: (paths) => ({ input: patch(paths) }),
		apply_patch: (paths) => ({ input: patch(paths) }),
	};
	for (const [tool, toInput] of Object.entries(manyPathInputs)) {
		for (const [ordering, spellings] of [
			["real first", ["real", "link"]],
			["link first", ["link", "real"]],
			["both twice", ["real", "link", "real", "link"]],
		] as const) {
			it(`${tool} keeps the symlink alias when one call names both spellings (${ordering})`, () => {
				const link = join(root, "link");
				symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
				const real = join(outside, "File.txt");
				const lexical = join(link, "File.txt");
				const request = external(
					tool,
					toInput(spellings.map((spelling) => (spelling === "real" ? real : lexical))),
					cwd,
				);
				expect(request.patterns).toEqual([real]);
				expect(request.ruleAliases).toEqual([lexical]);
				const service = new PermissionService(
					[
						{ permission: "external_directory", pattern: "*", action: "allow" },
						{ permission: "external_directory", pattern: `${link}/*`, action: "deny" },
					],
					[],
				);
				expect(service.dispatchDecision(request.permission, request.patterns, request).action).toBe("deny");
			});
		}
	}

	it("does not widen a wildcard lexical allow to the symlink target", async () => {
		const data = join(root, "data");
		mkdirSync(join(data, "a"), { recursive: true });
		symlinkSync(outside, join(data, "a", "secret"), process.platform === "win32" ? "junction" : "dir");
		const request = external("read", { path: join(data, "a", "secret", "File.txt") }, cwd);
		const emitter = createLocalEventEmitter();
		const service = new PermissionService(
			[{ permission: "external_directory", pattern: `${data}/*/secret/*`, action: "allow" }],
			[],
			emitter,
		);
		let prompted = false;
		emitter.onAsked((pending) => {
			prompted = true;
			service.reply({ requestID: pending.id, reply: "once" });
		});
		await service.ask({ ...request, sessionID: "lexical-allow", metadata: {} }, { ruleAliases: request.ruleAliases });
		expect(prompted).toBe(true);
	});

	it("refreshes filesystem identity between evaluations after a rule symlink changes", () => {
		const alias = join(root, "alias");
		symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
		const service = new PermissionService(
			[{ permission: "external_directory", pattern: `${alias}/*`, action: "allow" }],
			[],
		);
		const target = join(outside, "File.txt");
		expect(service.dispatchDecision("external_directory", target).action).toBe("allow");
		rmSync(alias);
		symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
		expect(service.dispatchDecision("external_directory", target).action).toBe("ask");
	});

	for (const suffix of ["File.txt", "missing/nested/file.txt"]) {
		it(`H1: denies both spellings of an external case alias: ${suffix}`, (context) => {
			const alternate = join(root, "outside");
			try {
				const actual = statSync(outside);
				const alias = statSync(alternate);
				if (actual.dev !== alias.dev || actual.ino !== alias.ino) return context.skip();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return context.skip();
			}
			for (const rulePath of [join(outside, suffix), join(alternate, suffix)]) {
				const service = new PermissionService(
					[
						{ permission: "external_directory", pattern: "*", action: "allow" },
						{ permission: "external_directory", pattern: rulePath, action: "deny" },
					],
					[],
				);
				for (const target of [join(outside, suffix), join(alternate, suffix)]) {
					const request = external("write", { path: target }, cwd);
					expect(service.dispatchDecision(request.permission, request.patterns).action).toBe("deny");
				}
			}
		});
	}

	// senpi#4351 H1-GLOB: case changes after the first wildcard must not evade a deny.
	for (const [pattern, direct, alternate] of [
		["*.json", "package.json", "PACKAGE.JSON"],
		["*.JSON", "package.json", "PACKAGE.JSON"],
		["*a*.json", "package.json", "PACKAGE.JSON"],
		["*/File.txt", "Nested/File.txt", "NESTED/FILE.TXT"],
		["*/Nested/*.txt", "dir/Nested/File.txt", "DIR/NESTED/FILE.TXT"],
		["*.txt", "dir/Nested/File.txt", "DIR/NESTED/FILE.TXT"],
		["*?Nested?*.txt", "dir/Nested/File.txt", "DIR/NESTED/FILE.TXT"],
		["*/Nested/missing/new.txt", "dir/Nested/missing/new.txt", "DIR/NESTED/missing/new.txt"],
	]) {
		it(`H1-GLOB: denies both case spellings for ${pattern}`, (context) => {
			writeFileSync(join(outside, "package.json"), "{}");
			mkdirSync(join(outside, "Nested"));
			writeFileSync(join(outside, "Nested", "File.txt"), "fixture");
			mkdirSync(join(outside, "dir", "Nested"), { recursive: true });
			writeFileSync(join(outside, "dir", "Nested", "File.txt"), "fixture");
			const actual = statSync(join(outside, "package.json"), { bigint: true });
			try {
				const alias = statSync(join(outside, "PACKAGE.JSON"), { bigint: true });
				expect(alias.dev).toBe(actual.dev);
				expect(alias.ino).toBe(actual.ino);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return context.skip();
			}
			const service = new PermissionService(
				[
					{ permission: "external_directory", pattern: "*", action: "allow" },
					{ permission: "external_directory", pattern: `${outside}/${pattern}`, action: "deny" },
				],
				[],
			);
			for (const target of [direct, alternate]) {
				const request = external("write", { path: join(outside, target) }, cwd);
				expect(service.dispatchDecision(request.permission, request.patterns).action).toBe("deny");
			}
			const missing = external("write", { path: join(outside, "dir/Nested/missing/NEW.TXT") }, cwd);
			if (pattern.endsWith("missing/new.txt")) {
				expect(service.dispatchDecision(missing.permission, missing.patterns).action).toBe("allow");
			}
		});
	}

	it("H1-GLOB: keeps distinct case-sensitive suffixes separate", (context) => {
		writeFileSync(join(outside, "package.json"), "{}");
		try {
			writeFileSync(join(outside, "PACKAGE.JSON"), "other", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return context.skip();
		}
		expect(statSync(join(outside, "package.json")).ino).not.toBe(statSync(join(outside, "PACKAGE.JSON")).ino);
		const service = new PermissionService(
			[
				{ permission: "external_directory", pattern: "*", action: "allow" },
				{ permission: "external_directory", pattern: `${outside}/*.json`, action: "deny" },
			],
			[],
		);
		for (const [target, action] of [
			["package.json", "deny"],
			["PACKAGE.JSON", "allow"],
		]) {
			const request = external("write", { path: join(outside, target) }, cwd);
			expect(service.dispatchDecision(request.permission, request.patterns).action).toBe(action);
		}
	});

	it("H1: reuses persisted Always scopes across external case aliases", async (context) => {
		const alternate = join(root, "outside");
		try {
			const actual = statSync(outside);
			const alias = statSync(alternate);
			if (actual.dev !== alias.dev || actual.ino !== alias.ino) return context.skip();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return context.skip();
		}
		const emitter = createLocalEventEmitter();
		const service = new PermissionService([], [], emitter);
		emitter.onAsked((request) => service.reply({ requestID: request.id, reply: "always" }));
		const request = external("write", { path: join(alternate, "missing", "file.txt") }, cwd);
		await service.ask({ ...request, sessionID: "case", metadata: {} });
		const agentDir = join(root, "agent");
		appendApproved(agentDir, cwd, service.getSessionApproved());
		const reloaded = new PermissionService([], loadApproved(agentDir, cwd));
		const direct = external("write", { path: join(outside, "missing", "other.txt") }, cwd);
		expect(reloaded.dispatchDecision(direct.permission, direct.patterns).action).toBe("allow");
		expect(reloaded.dispatchDecision("external_directory", join(root, "sibling.txt")).action).toBe("ask");
	});

	it("H1: keeps distinct case-sensitive external directories separate", (context) => {
		const other = join(root, "outside");
		try {
			mkdirSync(other);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return context.skip();
		}
		const service = new PermissionService(
			[{ permission: "external_directory", pattern: `${outside}/*`, action: "deny" }],
			[{ permission: "external_directory", pattern: `${other}/*`, action: "allow" }],
		);
		expect(service.dispatchDecision("external_directory", join(outside, "new.txt")).action).toBe("deny");
		expect(service.dispatchDecision("external_directory", join(other, "new.txt")).action).toBe("allow");
	});

	it.each(["bash", "bash_input", "monitor"])(
		"H2: %s Always approves only the resolved trailing-slash directory",
		async (tool) => {
			const directory = join(outside, "changes");
			mkdirSync(directory);
			const alias = join(root, "alias");
			symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
			const command = `ls "${alias}/"`;
			const request = external(tool, tool === "bash_input" ? { input: command } : { command }, cwd);
			const emitter = createLocalEventEmitter();
			const service = new PermissionService([], [], emitter);
			const sibling = join(outside, "package.json");
			expect(service.dispatchDecision("external_directory", sibling).action).toBe("ask");
			emitter.onAsked((pending) => service.reply({ requestID: pending.id, reply: "always" }));
			await service.ask({ ...request, sessionID: "scope", metadata: {} });
			expect(service.dispatchDecision("external_directory", sibling).action).toBe("ask");
			expect(service.dispatchDecision("external_directory", directory).action).toBe("ask");
			expect(service.getSessionApproved()).toEqual([
				{ permission: "external_directory", pattern: `${directory}/*`, action: "allow" },
			]);
			expect(service.dispatchDecision("external_directory", join(directory, "entry.txt")).action).toBe("allow");
		},
	);
});
