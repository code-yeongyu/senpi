import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import {
	createPathIdentityResolver,
	type PathIdentityResolver,
	RULE_FILL_DEADLINE_MS,
} from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";
import { type FixtureTransport, fixtureTransport } from "./path-identity-fixtures.ts";

describe("rule identity cache invalidation (design 6.5 / 11.1.6)", () => {
	let root: string;
	let real: string;
	let resolver: PathIdentityResolver;
	let transport: FixtureTransport;
	const rule = (): Rule => ({ permission: "read", pattern: `${root}/link/secret`, action: "deny" });
	const ruleFills = () => transport.posted.filter((request) => request.kind === "canonicalizeRule").length;

	const decide = async (service: PermissionService, permission: string, executed: string) => {
		const prepared = service.prepareIdentity(permission, [executed], root);
		const identity = prepared instanceof Promise ? await prepared : prepared;
		return service.dispatchDecision(permission, executed, { ruleAliases: [executed], identity }).action;
	};
	const decidedWrite = (service: PermissionService, written: string, executed?: string) =>
		service.ask(
			{
				sessionID: "s",
				permission: executed === undefined ? "mytool" : "edit",
				patterns: [written],
				always: [],
				metadata: {},
			},
			{ autoApproveAsk: true, ...(executed === undefined ? {} : { executed: [executed] }) },
		);

	beforeEach(async () => {
		vi.useFakeTimers();
		root = mkdtempSync(join(tmpdir(), "rule-cache-"));
		real = realpathSync.native(root);
		mkdirSync(join(root, "real_a"));
		mkdirSync(join(root, "real_b"));
		mkdirSync(join(root, "elsewhere"));
		writeFileSync(join(root, "real_a", "secret"), "A");
		writeFileSync(join(root, "real_b", "secret"), "B");
		symlinkSync(join(root, "real_a"), join(root, "link"));
		transport = fixtureTransport();
		resolver = createPathIdentityResolver({ spawn: () => transport, log: () => {} });
	});

	afterEach(async () => {
		await resolver.close();
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("a decided write inside the rule chain drops the entry and the next decision follows the new target", async () => {
		const service = new PermissionService(
			[rule(), { permission: "edit", pattern: "*", action: "allow" }],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		await vi.advanceTimersByTimeAsync(RULE_FILL_DEADLINE_MS);
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("deny");
		const fillsBefore = ruleFills();
		rmSync(join(root, "link"));
		symlinkSync(join(root, "real_b"), join(root, "link"));
		await decidedWrite(service, "link", `${root}/link`);
		expect(service.ruleIdentityState(rule().pattern)).toBe("pending");
		expect(await decide(service, "read", `${real}/real_b/secret`)).toBe("deny");
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("ask");
		expect(ruleFills()).toBeGreaterThan(fillsBefore);
	});

	it("a decided write far from any rule chain leaves the cache untouched (negative control)", async () => {
		const service = new PermissionService(
			[rule(), { permission: "edit", pattern: "*", action: "allow" }],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		await vi.advanceTimersByTimeAsync(RULE_FILL_DEADLINE_MS);
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("deny");
		const fillsBefore = ruleFills();
		await decidedWrite(service, "elsewhere/x", `${root}/elsewhere/x`);
		expect(service.ruleIdentityState(rule().pattern)).toMatchObject({ prefix: `${real}/real_a/secret` });
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("deny");
		expect(ruleFills()).toBe(fillsBefore);
	});

	it("an UNDECIDED retarget keeps the old target denied and leaves the new file to the literal routes (L5)", async () => {
		const service = new PermissionService(
			[rule()],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		await vi.advanceTimersByTimeAsync(RULE_FILL_DEADLINE_MS);
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("deny");
		rmSync(join(root, "link"));
		symlinkSync(join(root, "real_b"), join(root, "link"));
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("deny");
		expect(await decide(service, "read", `${real}/real_b/secret`)).toBe("ask");
		expect(await decide(service, "read", `${root}/link/secret`)).toBe("deny");
	});

	it("an unknown tool's non-deny decision invalidates by prefix with a path arg and clears everything without one (M3)", async () => {
		const service = new PermissionService(
			[
				rule(),
				{ permission: "mytool", pattern: "*", action: "allow" },
				{ permission: "edit", pattern: "*", action: "allow" },
			],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		await vi.advanceTimersByTimeAsync(RULE_FILL_DEADLINE_MS);
		expect(await decide(service, "read", `${real}/real_a/secret`)).toBe("deny");
		await decidedWrite(service, "elsewhere/y", `${root}/elsewhere/y`);
		expect(service.ruleIdentityState(rule().pattern)).toMatchObject({ prefix: `${real}/real_a/secret` });
		await decidedWrite(service, "anything");
		expect(service.ruleIdentityState(rule().pattern)).toBe("pending");
	});
});
