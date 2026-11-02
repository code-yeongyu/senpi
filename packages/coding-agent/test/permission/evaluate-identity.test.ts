import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../../src/core/settings-manager.ts";
import { findDenyProvenance } from "../../src/core/extensions/builtin/permission-system/deny-provenance.ts";
import { evaluate, evaluateWithIdentity } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PATH_IDENTITY_VERSION } from "../../src/core/extensions/builtin/permission-system/path-identity.ts";
import {
	createPathIdentityResolver,
	type PathIdentityResolver,
} from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import { type IdentityInput, PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { DeniedError, type Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";
import { fixtureTransport } from "./path-identity-fixtures.ts";

const darwin = process.platform === "darwin";

function sameEntry(a: string, b: string): boolean {
	try {
		const x = lstatSync(a, { bigint: true });
		const y = lstatSync(b, { bigint: true });
		return x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
}

describe("path rules decide by file identity across spellings (design 11.1.2)", () => {
	let root: string;
	let real: string;
	let resolver: PathIdentityResolver;
	const deny = (pattern: string, permission = "read"): Rule => ({ permission, pattern, action: "deny" });
	const allow = (pattern: string, permission = "read"): Rule => ({ permission, pattern, action: "allow" });

	const serviceWith = (rules: Rule[], approved: Rule[] = []) =>
		new PermissionService(rules, approved, createLocalEventEmitter(), undefined, root, undefined, resolver);

	const decide = async (service: PermissionService, permission: string, written: string, executed: string) => {
		const identity = await service.prepareIdentity(permission, [executed], root);
		return service.dispatchDecision(permission, written, { ruleAliases: [written, executed], identity });
	};

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "evaluate-identity-"));
		real = realpathSync.native(root);
		mkdirSync(join(root, "real", "sub"), { recursive: true });
		writeFileSync(join(root, "real", "secret"), "S");
		writeFileSync(join(root, "real", "sub", "a.env"), "E");
		symlinkSync(join(root, "real"), join(root, "link"));
		symlinkSync(join(root, "real"), join(root, "other"));
		symlinkSync(join(root, "real", "secret"), join(root, "flink"));
		if (darwin) writeFileSync(join(root, "real", "caf\u00e9.txt"), "C");
		resolver = createPathIdentityResolver({ spawn: () => fixtureTransport() });
	});

	afterAll(async () => {
		await resolver.close();
		rmSync(root, { recursive: true, force: true });
	});

	it.each([
		["rule via symlink x request real", () => `${root}/link/secret`, () => `${real}/real/secret`],
		["rule real x request via symlink", () => `${real}/real/secret`, () => `${root}/link/secret`],
		["rule via one link x request via another", () => `${root}/link/secret`, () => `${root}/other/secret`],
		["rule via file link x request real", () => `${root}/flink`, () => `${real}/real/secret`],
		["glob prefix via link x request real", () => `${root}/link/sub/*.env`, () => `${real}/real/sub/a.env`],
	])("%s: deny", async (_name, rule, request) => {
		const service = serviceWith([deny(rule())]);
		expect((await decide(service, "read", request(), request())).action).toBe("deny");
	});

	it("case alias: a rule in another case denies the on-disk spelling where the volume folds case", async (context) => {
		if (!sameEntry(`${root}/REAL/secret`, `${root}/real/secret`)) {
			context.skip();
			return;
		}
		const service = serviceWith([deny(`${root}/REAL/SECRET`)]);
		expect((await decide(service, "read", `${real}/real/secret`, `${real}/real/secret`)).action).toBe("deny");
	});

	it.skipIf(!darwin)("NFC and NFD spellings of an existing file and of a missing tail decide alike (H3)", async () => {
		const nfc = `${real}/real/caf\u00e9.txt`;
		const nfd = `${root}/real/cafe\u0301.txt`;
		expect((await decide(serviceWith([deny(nfd)]), "read", nfc, nfc)).action).toBe("deny");
		expect((await decide(serviceWith([deny(nfc)]), "read", nfd, nfd)).action).toBe("deny");
		const missingNfc = `${real}/real/new/caf\u00e9`;
		const missingNfd = `${root}/real/new/cafe\u0301`;
		expect((await decide(serviceWith([deny(missingNfd, "edit")]), "edit", missingNfc, missingNfc)).action).toBe(
			"deny",
		);
	});

	it("an approved allow via an alias allows the real spelling", async () => {
		const service = serviceWith(
			[{ permission: "read", pattern: "*", action: "ask" }],
			[allow(`${root}/link/secret`)],
		);
		expect((await decide(service, "read", `${real}/real/secret`, `${real}/real/secret`)).action).toBe("allow");
	});

	it("a relative rule and a bare name still deny the written spelling with the canonical route off (C1)", () => {
		const service = serviceWith([deny("src/*.env"), deny("secret.json")]);
		expect(service.dispatchDecision("read", "src/a.env").action).toBe("deny");
		expect(service.dispatchDecision("read", "secret.json").action).toBe("deny");
		expect(service.dispatchDecision("read", `${real}/src/a.env`).action).toBe("ask");
	});

	it("an absolute rule matches the executed spelling with the canonical route off (route b)", () => {
		const service = serviceWith([deny(`${real}/real/secret`)]);
		expect(
			service.dispatchDecision("read", "link/secret", { ruleAliases: ["link/secret", `${real}/real/secret`] })
				.action,
		).toBe("deny");
	});

	it("grep's regex form carries no executed path and gets no identity route (M6)", () => {
		const registry = createBuiltinParserRegistry();
		const regex = registry
			.parse("grep", { pattern: "secret" }, root)
			.find((request) => request.permission === "grep");
		expect(regex?.executed).toBeUndefined();
		const withPath = registry
			.parse("grep", { pattern: "x", path: "link" }, root)
			.find((request) => request.permission === "grep");
		expect(withPath?.executed).toEqual([`${root}/link`]);
	});

	it("external_directory never receives the identity predicate (M4)", async () => {
		const outside = mkdtempSync(join(tmpdir(), "evaluate-identity-outside-"));
		try {
			const alias = join(root, "outside-link");
			symlinkSync(outside, alias);
			const service = serviceWith([deny(`${alias}/*`, "external_directory")]);
			const identity: IdentityInput = {
				canonical: [{ path: `${realpathSync.native(outside)}/f`, foldCase: false }],
			};
			const target = `${realpathSync.native(outside)}/f`;
			expect(service.dispatchDecision("external_directory", target, { identity }).action).toBe(
				service.dispatchDecision("external_directory", target).action,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("an unresolvable request is a synthetic deny only when a deny of its class exists (6.1.3)", () => {
		const unresolvable: IdentityInput = { canonical: [], unresolvable: "EACCES" };
		const withDeny = serviceWith([deny(`${real}/elsewhere`)]);
		const decision = withDeny.dispatchDecision("read", `${root}/x`, { identity: unresolvable });
		expect(decision.action).toBe("deny");
		expect(decision.rules[0]?.pattern).toBe("(path could not be resolved: EACCES)");
		const withoutDeny = serviceWith([allow(`${real}/elsewhere`)]);
		expect(withoutDeny.dispatchDecision("read", `${root}/x`, { identity: unresolvable }).action).toBe("ask");
		const otherClass = serviceWith([deny("rm *", "bash")]);
		expect(otherClass.dispatchDecision("read", `${root}/x`, { identity: unresolvable }).action).toBe("ask");
	});

	it("the refusal names the user's layer for an identity match (provenance)", async () => {
		const service = serviceWith([deny(`${root}/link/secret`)]);
		const identity = await service.prepareIdentity("read", [`${real}/real/secret`], root);
		const settings = {
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({ permission: { read: { [`${root}/link/secret`]: "deny" } } }),
		} as unknown as SettingsManager;
		const provenance = findDenyProvenance(
			settings,
			[],
			"read",
			[`${real}/real/secret`],
			service.identityMatcher("read", identity),
		);
		expect(provenance).toMatchObject({ layer: "project", pattern: `${root}/link/secret` });
		expect(findDenyProvenance(settings, [], "read", [`${real}/real/secret`])).toBeUndefined();
	});

	it("ask() appends the executed strings to ruleAliases, keeps the written pattern as target, and names only the written pattern (N8, N9)", async () => {
		const service = serviceWith([deny(`${real}/real/secret`)]);
		const spy = vi.spyOn(service, "dispatchDecision");
		const request = {
			sessionID: "s",
			permission: "read",
			patterns: ["link/secret"],
			always: ["link/secret"],
			metadata: {},
		};
		await expect(
			service.ask(request, { ruleAliases: ["link/secret", "bundled"], executed: [`${root}/link/secret`] }),
		).rejects.toThrow(DeniedError);
		const [permission, target, options] = spy.mock.calls[0] ?? [];
		expect(permission).toBe("read");
		expect(target).toBe("link/secret");
		expect(options?.ruleAliases).toEqual(["link/secret", "bundled", `${root}/link/secret`]);
		expect(options?.identity?.canonical.map((entry) => entry.path)).toEqual([`${real}/real/secret`]);
		const denied = await service.ask(request, { executed: [`${root}/link/secret`] }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(denied).toBeInstanceOf(DeniedError);
		expect((denied as DeniedError).patterns).toEqual(["link/secret"]);
	});

	it("a kernel canonical with the current version is used as is; absent or stale ones go through the host resolver (N6)", async () => {
		const service = serviceWith([deny(`${root}/link/secret`)]);
		await service.identitySettled();
		const executed = `${real}/real/secret`;
		const current = service.prepareIdentity("read", [executed], root, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/real/secret`, foldCase: false },
		});
		expect(current).not.toBeInstanceOf(Promise);
		expect(service.dispatchDecision("read", executed, { identity: await current }).action).toBe("deny");
		const absent = await service.prepareIdentity("read", [executed], root);
		expect(service.dispatchDecision("read", executed, { identity: absent }).action).toBe("deny");
		const stale = await service.prepareIdentity("read", [executed], root, {
			canonical: { v: PATH_IDENTITY_VERSION + 1, path: "/nowhere", foldCase: false },
		});
		expect(stale.canonical.map((entry) => entry.path)).toEqual([`${real}/real/secret`]);
		expect(service.dispatchDecision("read", executed, { identity: stale }).action).toBe("deny");
	});

	it("the request target's foldCase governs the comparison (N6)", async () => {
		// Existing components come back in on-disk case from native; only a missing tail keeps the rule's case.
		const service = serviceWith([deny(`${real}/real/new/SECRET`)]);
		await service.identitySettled();
		const folded: IdentityInput = { canonical: [{ path: `${real}/real/new/secret`, foldCase: true }] };
		const exact: IdentityInput = { canonical: [{ path: `${real}/real/new/secret`, foldCase: false }] };
		expect(service.dispatchDecision("read", `${real}/real/new/secret`, { identity: folded }).action).toBe("deny");
		expect(service.dispatchDecision("read", `${real}/real/new/secret`, { identity: exact }).action).toBe("ask");
	});

	it("the ordering edge is kept: a later allow on another spelling still wins (7.3)", async () => {
		const service = serviceWith([deny(`${real}/real/secret`), allow(`${root}/link/secret`)]);
		expect((await decide(service, "read", `${real}/real/secret`, `${real}/real/secret`)).action).toBe("allow");
	});

	it.skipIf(!darwin)(
		"a firmlink spelling matches a rule on the canonical spelling whatever native form the host keeps (design row 895)",
		async () => {
			// The vitest host is Node, whose realpathSync.native keeps the /System/Volumes/Data spelling; the real
			// fixture transport below therefore reports that spelling as the canonical form, exactly as a Node
			// install would. Both sides are compared after the firmlink rewrite, so the rule still applies.
			const executed = `/System/Volumes/Data${real}/real/secret`;
			const onCanonical = serviceWith([deny(`${real}/real/secret`)]);
			expect((await decide(onCanonical, "read", executed, executed)).action).toBe("deny");
			const onFirmlink = serviceWith([deny(`/System/Volumes/Data${real}/link/secret`)]);
			expect((await decide(onFirmlink, "read", `${real}/real/secret`, `${real}/real/secret`)).action).toBe("deny");
			const viaLink = serviceWith([deny(`${real}/real/secret`)]);
			expect(
				(
					await decide(
						viaLink,
						"read",
						`/System/Volumes/Data${real}/link/secret`,
						`/System/Volumes/Data${real}/link/secret`,
					)
				).action,
			).toBe("deny");
			const nodeNative: IdentityInput = { canonical: [{ path: executed, foldCase: false }] };
			await onCanonical.identitySettled();
			expect(onCanonical.dispatchDecision("read", executed, { identity: nodeNative }).action).toBe("deny");
		},
	);

	it("the identity retained for a refusal's provenance is released once the request settles", async () => {
		const service = serviceWith([deny(`${root}/link/secret`), allow(`${real}/real/allowed`)]);
		const request = (id: string, written: string) => ({
			id,
			sessionID: "s",
			permission: "read",
			patterns: [written],
			always: [written],
			metadata: {},
		});
		const denied = await service.ask(request("r-deny", "link/secret"), { executed: [`${root}/link/secret`] }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(denied).toBeInstanceOf(DeniedError);
		expect((denied as DeniedError).identity?.canonical.map((entry) => entry.path)).toEqual([`${real}/real/secret`]);
		expect(service.requestIdentity("r-deny")).toBeUndefined();
		await service.ask(request("r-allow", "real/allowed"), { executed: [`${real}/real/allowed`] });
		expect(service.requestIdentity("r-allow")).toBeUndefined();
		const emitter = createLocalEventEmitter();
		const asking = new PermissionService(
			[deny(`${root}/link/secret`)],
			[],
			emitter,
			undefined,
			root,
			undefined,
			resolver,
		);
		emitter.onAsked((asked) => {
			expect(asking.requestIdentity(asked.id)).toBeDefined();
			asking.reply({ requestID: asked.id, reply: "once" });
		});
		await asking.ask(request("r-ask", "real/other"), { executed: [`${real}/real/other`] });
		expect(asking.requestIdentity("r-ask")).toBeUndefined();
	});

	it("external_directory keeps its own inode matcher under evaluateWithIdentity: identity is added, never substituted", () => {
		const rule = deny(`${real}/real/secret`, "external_directory");
		const alias = `${root}/link/secret`;
		expect(evaluate("external_directory", alias, [rule])).toBe(rule);
		expect(evaluateWithIdentity("external_directory", alias, [rule], undefined)).toBe(rule);
	});

	it("external_directory: a rule written through a link denies the real path at the service boundary", () => {
		// The direction only the inode matcher reaches: no spelling of the request matches the rule lexically.
		const viaLink = deny(`${root}/link/secret`, "external_directory");
		const service = serviceWith([allow("*", "external_directory"), viaLink]);
		expect(service.dispatchDecision("external_directory", `${real}/real/secret`).action).toBe("deny");
		expect(service.dispatchDecision("external_directory", `${real}/real/sub/a.env`).action).toBe("allow");
	});

	it("zero path rules: nothing is canonicalized and decisions are unchanged", async () => {
		const service = serviceWith([deny("rm *", "bash")]);
		expect(service.identityWanted("read")).toBe(false);
		const identity = service.prepareIdentity("read", [`${root}/link/secret`], root);
		expect(identity).not.toBeInstanceOf(Promise);
		expect(service.dispatchDecision("read", `${root}/link/secret`, { identity: await identity }).action).toBe("ask");
	});
});
