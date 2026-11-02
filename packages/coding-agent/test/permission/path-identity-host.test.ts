import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { parseMountTable } from "../../src/core/extensions/builtin/permission-system/mount-table.ts";
import { PATH_IDENTITY_VERSION } from "../../src/core/extensions/builtin/permission-system/path-identity.ts";
import {
	BREAKER_BACKOFF_MAX_MS,
	BREAKER_BACKOFF_MS,
	createPathIdentityResolver,
	LEAK_GRACE_MS,
	MAX_LEAKED_WORKERS,
	type PathIdentityResolver,
	resolverDeadlineMs,
	type ResolverStateEvent,
	RULE_FILL_DEADLINE_MS,
} from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import type { ResolverRequest } from "../../src/core/extensions/builtin/permission-system/path-identity-protocol.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { DeniedError, type Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";
import { type FixtureTransport, fixtureTransport } from "./path-identity-fixtures.ts";

const DEADLINE = resolverDeadlineMs(2000);
const requestPath = (request: ResolverRequest): string =>
	"path" in request ? request.path : "pattern" in request ? request.pattern : "";

async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, code: (error as { code?: string }).code ?? "UNKNOWN" };
	}
}

async function flush(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

describe("resolver deadline derivation (N7)", () => {
	it.each([
		[2000, 1500],
		[10_000, 1500],
		[800, 600],
	])("checkDeadlineMs %d -> %d ms", (input, expected) => {
		expect(resolverDeadlineMs(input)).toBe(expected);
	});
});

describe("path identity resolver worker (design 6.7 / 11.1.3)", () => {
	let root: string;
	let real: string;
	const events: ResolverStateEvent[] = [];
	const resolvers: PathIdentityResolver[] = [];

	const make = (transportFor: () => FixtureTransport, checkDeadlineMs = 2000) => {
		const resolver = createPathIdentityResolver({
			checkDeadlineMs,
			spawn: transportFor,
			onState: (event) => events.push(event),
			log: () => {},
		});
		resolvers.push(resolver);
		return resolver;
	};

	beforeEach(() => {
		vi.useFakeTimers();
		events.length = 0;
		root = mkdtempSync(join(tmpdir(), "resolver-host-"));
		real = realpathSync.native(root);
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "secret"), "S");
		symlinkSync(join(root, "real"), join(root, "link"));
	});

	afterEach(async () => {
		for (const resolver of resolvers.splice(0)) await resolver.close();
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("answers canonicalize, canonicalizeRule, detect and walk", async () => {
		const resolver = make(() => fixtureTransport());
		const canonical = resolver.canonicalize(`${root}/link/secret`);
		await flush(0);
		expect((await canonical).path).toBe(`${real}/real/secret`);
		const rule = resolver.canonicalizeRule(`${root}/link/*`);
		await flush(0);
		expect(await rule).toMatchObject({ prefix: `${real}/real`, suffix: "/*" });
		const alias = resolver.detect(`${root}/link/secret`);
		const plain = resolver.detect(`${real}/real/secret`);
		await flush(0);
		expect(await alias).toBe(true);
		expect(await plain).toBe(false);
		const walked = resolver.walk(`${root}/link/secret`);
		await flush(0);
		expect(await walked).toBe(`${real}/real/secret`);
	});

	it("a request that never returns times out with ETIMEDOUT and every queued request is rejected at its own deadline, not k x deadline (N5)", async () => {
		const transport = fixtureTransport({ stall: () => true });
		const resolver = make(() => transport);
		const first = settled(resolver.canonicalize(`${root}/a`));
		await flush(500);
		const second = settled(resolver.canonicalize(`${root}/b`));
		const third = settled(resolver.canonicalize(`${root}/c`));
		let ticks = 0;
		const ticker = setInterval(() => (ticks += 1), 100);
		await flush(DEADLINE - 500);
		clearInterval(ticker);
		expect(await first).toEqual({ ok: false, code: "ETIMEDOUT" });
		expect(await second).toEqual({ ok: false, code: "ETIMEDOUT" });
		expect(await third).toEqual({ ok: false, code: "ETIMEDOUT" });
		expect(transport.terminated.count).toBe(1);
		expect(ticks).toBeGreaterThan(5);
	});

	it("the breaker opens after two consecutive timeouts per key, answers at once while open, half-opens after back-off and closes on a probe (N2)", async () => {
		let stall = true;
		const transports: FixtureTransport[] = [];
		const resolver = make(() => {
			const transport = fixtureTransport({ stall: () => stall });
			transports.push(transport);
			return transport;
		});
		resolver.start();
		const key = resolver.volumeKey(`${root}/x`);
		expect(key).not.toBe("unknown");
		for (let attempt = 0; attempt < 2; attempt++) {
			const request = settled(resolver.canonicalize(`${root}/x${attempt}`));
			await flush(DEADLINE);
			expect(await request).toEqual({ ok: false, code: "ETIMEDOUT" });
		}
		expect(resolver.breakerState(key)).toBe("open");
		const started = Date.now();
		const immediate = settled(resolver.canonicalize(`${root}/y`));
		expect(await immediate).toEqual({ ok: false, code: "ETIMEDOUT" });
		expect(Date.now() - started).toBe(0);
		await flush(BREAKER_BACKOFF_MS);
		expect(resolver.breakerState(key)).toBe("half-open");
		stall = false;
		const probe = resolver.canonicalize(`${root}/link/secret`);
		await flush(0);
		expect((await probe).path).toBe(`${real}/real/secret`);
		expect(resolver.breakerState(key)).toBe("closed");
		expect(events.filter((event) => event.volumeKey === key).map((event) => event.state)).toEqual([
			"open",
			"half-open",
			"closed",
		]);
	});

	it("a wedge on one volume key leaves another key fully served (R3-M2) and the boot-volume keys are independent", async () => {
		const snapshot = parseMountTable(
			[
				"/dev/disk1 on / (apfs, local)",
				"/dev/disk2 on /System/Volumes/Data (apfs, local)",
				"map auto_home on /System/Volumes/Data/home (autofs, nobrowse)",
			].join("\n"),
			"darwin",
		);
		const resolver = make(() =>
			fixtureTransport({
				snapshot,
				firmlinks: ["/Users", "/private", "/home", "/tmp"],
				stall: (request) => requestPath(request).startsWith("/home/"),
			}),
		);
		resolver.start();
		expect(resolver.volumeKey("/home/x")).toBe("/System/Volumes/Data/home");
		expect(resolver.volumeKey("/Users/x")).toBe("/System/Volumes/Data");
		expect(resolver.volumeKey("/usr/bin/x")).toBe("/");
		for (let attempt = 0; attempt < 2; attempt++) {
			const stalled = settled(resolver.detect(`/home/wedged${attempt}`));
			await flush(DEADLINE);
			expect(await stalled).toEqual({ ok: true, value: true });
		}
		expect(resolver.breakerState("/System/Volumes/Data/home")).toBe("open");
		expect(resolver.breakerState("/System/Volumes/Data")).toBe("closed");
		expect(resolver.breakerState("/")).toBe("closed");
		const served = resolver.walk(`${root}/link/secret`);
		await flush(0);
		expect(await served).toBe(`${real}/real/secret`);
	});

	it("leaked workers are bounded by the cap and a late terminate decrements the count (R3-M1)", async () => {
		const transports: FixtureTransport[] = [];
		const resolver = make(() => {
			const transport = fixtureTransport({ stall: () => true, terminateResolves: false });
			transports.push(transport);
			return transport;
		});
		// Every stall is keyed to the same volume, so the breaker opens after two and later attempts run
		// only at its half-open probes; the thread count is bounded by the cap regardless.
		for (let attempt = 0; attempt < 20; attempt++) {
			const request = settled(resolver.canonicalize(`/volume${attempt}/x`));
			await flush(DEADLINE + LEAK_GRACE_MS + BREAKER_BACKOFF_MAX_MS);
			expect(await request).toEqual({ ok: false, code: "ETIMEDOUT" });
		}
		expect(transports.length).toBe(MAX_LEAKED_WORKERS);
		expect(resolver.leaked).toBe(MAX_LEAKED_WORKERS);
		expect(events.some((event) => event.state === "leak-cap")).toBe(true);
		// At the cap the probe is deferred: the breaker stays open and no thread is spawned.
		expect(resolver.breakerState("/")).toBe("open");
		const capped = settled(resolver.canonicalize("/volume98/x"));
		await flush(0);
		expect(await capped).toEqual({ ok: false, code: "ETIMEDOUT" });
		expect(transports.length).toBe(MAX_LEAKED_WORKERS);
		transports[0]?.terminated.resolve();
		await flush(0);
		expect(resolver.leaked).toBe(MAX_LEAKED_WORKERS - 1);
		expect(events.at(-1)?.state).toBe("leak-recovered");
		await flush(BREAKER_BACKOFF_MAX_MS);
		expect(resolver.breakerState("/")).toBe("half-open");
		const again = settled(resolver.canonicalize("/volume99/x"));
		await flush(0);
		expect(transports.length).toBe(MAX_LEAKED_WORKERS + 1);
		await flush(DEADLINE);
		expect(await again).toEqual({ ok: false, code: "ETIMEDOUT" });
	});

	it("the host side imports no filesystem module: the breaker key is lexical (R4-H2)", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(
			resolve(here, "../../src/core/extensions/builtin/permission-system/path-identity-host.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/from "node:fs/u);
		expect(source).not.toMatch(/Sync\(/u);
		const resolver = make(() => fixtureTransport());
		resolver.start();
		expect(resolver.volumeKey(`${root}/link/secret`)).not.toBe("unknown");
	});
});

describe("resolver worker that cannot start (fail safe, fail loud)", () => {
	let root: string;
	const deny = (pattern: string, permission = "read"): Rule => ({ permission, pattern, action: "deny" });
	const allow = (pattern: string, permission = "read"): Rule => ({ permission, pattern, action: "allow" });

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "resolver-unavailable-"));
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "notes.txt"), "N");
		writeFileSync(join(root, "real", "app.env"), "E");
		symlinkSync(join(root, "real"), join(root, "link"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("a startup error marks the resolver unavailable once, loudly, and rejects at once instead of timing out", async () => {
		const fatal: string[] = [];
		const states: ResolverStateEvent[] = [];
		const transport = fixtureTransport({ startupError: "ERR_MODULE_NOT_FOUND" });
		const resolver = createPathIdentityResolver({
			spawn: () => transport,
			log: () => {},
			fatal: (line) => fatal.push(line),
			onState: (event) => states.push(event),
		});
		const unavailable = new Promise<void>((resolve) =>
			resolver.onState((event) => event.state === "unavailable" && resolve()),
		);
		const started = Date.now();
		const first = settled(resolver.canonicalize(`${root}/link/notes.txt`));
		await unavailable;
		expect(await first).toEqual({ ok: false, code: "EUNAVAILABLE" });
		expect(Date.now() - started).toBeLessThan(DEADLINE);
		expect(resolver.unavailable).toContain("ERR_MODULE_NOT_FOUND");
		expect(await settled(resolver.canonicalize(`${root}/link/notes.txt`))).toEqual({
			ok: false,
			code: "EUNAVAILABLE",
		});
		expect(await resolver.detect(`${root}/link/notes.txt`)).toBe(true);
		expect(fatal).toHaveLength(1);
		expect(fatal[0]).toContain("ERR_MODULE_NOT_FOUND");
		expect(states.map((event) => event.state)).toEqual(["unavailable"]);
		expect(transport.terminated.count).toBe(0);
		await resolver.close();
	});

	it("a real worker whose entry is missing reports unavailable through the same path", async () => {
		const fatal: string[] = [];
		const resolver = createPathIdentityResolver({
			workerEntry: new URL("./no-such-path-identity-worker.js", import.meta.url),
			log: () => {},
			fatal: (line) => fatal.push(line),
		});
		const outcome = await settled(resolver.canonicalize(`${root}/link/notes.txt`));
		expect(outcome).toEqual({ ok: false, code: "EUNAVAILABLE" });
		expect(resolver.unavailable).toBeDefined();
		expect(fatal).toHaveLength(1);
		await resolver.close();
	}, 20_000);

	it("with the worker unavailable, a JS cell's kernel canonical still decides exactly: an alias to a denied file is denied, a plain file is allowed", async () => {
		const resolver = createPathIdentityResolver({
			spawn: () => fixtureTransport({ startupError: "ERR_MODULE_NOT_FOUND" }),
			log: () => {},
			fatal: () => {},
		});
		const unavailable = new Promise<void>((resolve) =>
			resolver.onState((event) => event.state === "unavailable" && resolve()),
		);
		resolver.start();
		await unavailable;
		const real = realpathSync.native(root);
		const s = new PermissionService(
			[allow("*"), deny(`${real}/real/app.env`)],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		const kernelCanonical = (path: string) => ({ canonical: { v: PATH_IDENTITY_VERSION, path, foldCase: false } });
		const viaAlias = s.prepareIdentity(
			"read",
			[`${root}/link/app.env`],
			root,
			kernelCanonical(`${real}/real/app.env`),
		);
		expect(viaAlias).not.toBeInstanceOf(Promise);
		expect(
			s.dispatchDecision("read", `${root}/link/app.env`, {
				ruleAliases: [`${root}/link/app.env`],
				identity: await viaAlias,
			}).action,
		).toBe("deny");
		const plain = s.prepareIdentity(
			"read",
			[`${real}/real/notes.txt`],
			root,
			kernelCanonical(`${real}/real/notes.txt`),
		);
		expect(
			s.dispatchDecision("read", `${real}/real/notes.txt`, {
				ruleAliases: [`${real}/real/notes.txt`],
				identity: await plain,
			}).action,
		).toBe("allow");
		const unresolved = s.prepareIdentity("read", [`${root}/link/notes.txt`], root, { unresolvable: "EACCES" });
		expect(
			s.dispatchDecision("read", `${root}/link/notes.txt`, {
				ruleAliases: [`${root}/link/notes.txt`],
				identity: await unresolved,
			}).action,
		).toBe("allow");
		await resolver.close();
	});

	it("with the worker unavailable, zero rules and plain rules decide exactly by spelling: no timeouts, no synthetic deny", async () => {
		const resolver = createPathIdentityResolver({
			spawn: () => fixtureTransport({ startupError: "ERR_MODULE_NOT_FOUND" }),
			log: () => {},
			fatal: () => {},
		});
		const unavailable = new Promise<void>((resolve) =>
			resolver.onState((event) => event.state === "unavailable" && resolve()),
		);
		resolver.start();
		await unavailable;
		const askFor = (service: PermissionService, permission: string, written: string, executed: string) =>
			settled(
				service.ask(
					{ sessionID: "s", permission, patterns: [written], always: [written], metadata: {} },
					{ autoApproveAsk: true, executed: [executed] },
				),
			);
		const zeroRules = new PermissionService(
			[deny("rm *", "bash")],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		expect(zeroRules.identityWanted("read")).toBe(false);
		expect(await askFor(zeroRules, "read", "link/notes.txt", `${root}/link/notes.txt`)).toEqual({
			ok: true,
			value: undefined,
		});
		const plainDeny = new PermissionService(
			[allow("*"), deny("*.env")],
			[],
			createLocalEventEmitter(),
			undefined,
			root,
			undefined,
			resolver,
		);
		expect(plainDeny.identityWanted("read")).toBe(false);
		expect(await askFor(plainDeny, "read", "notes.txt", `${root}/real/notes.txt`)).toEqual({
			ok: true,
			value: undefined,
		});
		const denied = await askFor(plainDeny, "read", "app.env", `${root}/real/app.env`);
		expect(denied.ok).toBe(false);
		const spy = vi.spyOn(plainDeny, "dispatchDecision");
		await askFor(plainDeny, "read", "notes.txt", `${root}/real/notes.txt`);
		expect(spy.mock.calls.every(([, , options]) => options?.identity === undefined)).toBe(true);
		await resolver.close();
	});
});

describe("permission service with a wedged or slow resolver (design 6.5, 6.5.1 / 11.1.3)", () => {
	let root: string;
	let real: string;
	const resolvers: PathIdentityResolver[] = [];
	const deny = (pattern: string, permission = "read"): Rule => ({ permission, pattern, action: "deny" });
	const allow = (pattern: string, permission = "read"): Rule => ({ permission, pattern, action: "allow" });

	const resolverWith = (options: Parameters<typeof fixtureTransport>[0] & { transports?: FixtureTransport[] }) => {
		const resolver = createPathIdentityResolver({
			spawn: () => {
				const transport = fixtureTransport(options);
				options.transports?.push(transport);
				return transport;
			},
			log: () => {},
		});
		resolvers.push(resolver);
		return resolver;
	};
	const service = (rules: Rule[], resolver: PathIdentityResolver, approved: Rule[] = []) => {
		const emitter = createLocalEventEmitter();
		const unavailable: { permission: string; pattern: string; code: string }[] = [];
		emitter.onRuleIdentityUnavailable((event) => unavailable.push(event));
		return {
			service: new PermissionService(rules, approved, emitter, undefined, root, undefined, resolver),
			unavailable,
		};
	};
	const decide = async (
		s: PermissionService,
		permission: string,
		executed: string,
		kernel?: Parameters<PermissionService["prepareIdentity"]>[3],
	) => {
		const prepared = s.prepareIdentity(permission, [executed], root, kernel);
		const identity = prepared instanceof Promise ? await prepared : prepared;
		return s.dispatchDecision(permission, executed, { ruleAliases: [executed], identity });
	};
	const ask = (s: PermissionService, permission: string, written: string, executed: string) =>
		settled(
			s.ask(
				{ sessionID: "s", permission, patterns: [written], always: [written], metadata: {} },
				{ autoApproveAsk: true, executed: [executed] },
			),
		);

	beforeEach(() => {
		vi.useFakeTimers();
		root = mkdtempSync(join(tmpdir(), "resolver-service-"));
		real = realpathSync.native(root);
		mkdirSync(join(root, "real", "dir"), { recursive: true });
		mkdirSync(join(root, "plain"));
		writeFileSync(join(root, "real", "secret"), "S");
		writeFileSync(join(root, "real", "dir", "f"), "F");
		writeFileSync(join(root, "plain", "p"), "P");
		symlinkSync(join(root, "real"), join(root, "link"));
	});

	afterEach(async () => {
		for (const resolver of resolvers.splice(0)) await resolver.close();
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("zero rules + a permanently wedged resolver: ask() never contacts the resolver and every call is unchanged (R3-H2)", async () => {
		const transports: FixtureTransport[] = [];
		const resolver = resolverWith({ stall: () => true, transports });
		const { service: s } = service([deny("rm *", "bash")], resolver);
		const outcome = ask(s, "read", "link/secret", `${root}/link/secret`);
		await flush(DEADLINE * 2);
		expect(await outcome).toEqual({ ok: true, value: undefined });
		expect(
			transports.flatMap((transport) => transport.posted.filter((request) => request.kind !== "refresh")),
		).toEqual([]);
	});

	it("ask() with a path-class rule and a rejecting resolver yields identity.unresolvable, never a thrown error (R3-H2)", async () => {
		const resolver = resolverWith({ stall: () => true });
		const { service: s } = service([deny(`${real}/plain/p`)], resolver);
		const spy = vi.spyOn(s, "dispatchDecision");
		const outcome = ask(s, "read", `${root}/link/secret`, `${root}/link/secret`);
		await flush(DEADLINE * 2);
		const result = await outcome;
		expect(result.ok ? "allowed" : result.code).not.toBe("ETIMEDOUT");
		expect(spy.mock.calls.at(-1)?.[2]?.identity?.unresolvable).toBe("ETIMEDOUT");
	});

	it("a plain deny with no alias in any rule and a wedge on another path decides plain paths exactly as with the resolver up (R3-C1)", async () => {
		let wedged = false;
		const resolver = resolverWith({ stall: (request) => wedged && requestPath(request).includes("/wedged/") });
		const { service: s } = service([deny(`${real}/real/secret`), allow(`${real}/plain/*`, "edit")], resolver);
		await flush(RULE_FILL_DEADLINE_MS);
		wedged = true;
		const stalled = decide(s, "read", `${real}/wedged/x`);
		await flush(DEADLINE * 2);
		expect((await stalled).rules[0]?.pattern).toBe("(path could not be resolved: ETIMEDOUT)");
		const plainRead = decide(s, "read", `${real}/plain/p`);
		await flush(DEADLINE);
		expect((await plainRead).action).toBe("ask");
		const plainEdit = decide(s, "edit", `${real}/plain/x`);
		await flush(DEADLINE);
		expect((await plainEdit).action).toBe("allow");
		const denied = decide(s, "read", `${real}/real/secret`);
		await flush(DEADLINE);
		expect((await denied).action).toBe("deny");
		const kernelExact = s.prepareIdentity("read", [`${real}/wedged/y`], root, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/wedged/y`, foldCase: false },
		});
		expect(kernelExact).not.toBeInstanceOf(Promise);
		expect(s.dispatchDecision("read", `${real}/wedged/y`, { identity: await kernelExact }).action).toBe("ask");
	});

	it("an aliased DENY rule whose identity form times out fails closed only for requests an alias could carry to it (6.5.1)", async () => {
		const transports: FixtureTransport[] = [];
		const resolver = resolverWith({
			stall: (request) => request.kind === "canonicalizeRule" && requestPath(request).includes("/link"),
			transports,
		});
		const { service: s, unavailable } = service([deny(`${root}/link/*`)], resolver);
		await flush(DEADLINE * 2);
		const under = decide(s, "read", `${real}/real/dir/f`, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/real/dir/f`, foldCase: false },
		});
		await flush(DEADLINE * 2);
		const underDecision = await under;
		expect(underDecision.action).toBe("deny");
		expect(underDecision.rules[0]?.pattern).toBe("(path could not be resolved: ETIMEDOUT)");
		expect(unavailable).toEqual([{ permission: "read", pattern: `${root}/link/*`, code: "ETIMEDOUT" }]);
		const elsewhere = decide(s, "read", `${real}/plain/p`, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/plain/p`, foldCase: false },
		});
		await flush(DEADLINE * 2);
		expect((await elsewhere).action).toBe("ask");
		const viaAlias = decide(s, "read", `${root}/link/secret`, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/real/secret`, foldCase: false },
		});
		await flush(DEADLINE * 2);
		expect((await viaAlias).action).toBe("deny");
	});

	it("an ALLOW rule whose identity form times out is literal-only for the duration and recovers after the breaker closes (N3, R3-M3)", async () => {
		let wedged = true;
		const resolver = resolverWith({ stall: (request) => wedged && request.kind === "canonicalizeRule" });
		const { service: s } = service([{ permission: "read", pattern: "*", action: "ask" }], resolver, [
			allow(`${root}/link/secret`),
		]);
		await flush(DEADLINE * 3);
		const during = decide(s, "read", `${real}/real/secret`, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/real/secret`, foldCase: false },
		});
		await flush(DEADLINE * 2);
		expect((await during).action).toBe("ask");
		wedged = false;
		await flush(BREAKER_BACKOFF_MS * 2);
		const probe = resolver.canonicalize(`${root}/link/secret`);
		await flush(0);
		await probe;
		const after = decide(s, "read", `${real}/real/secret`, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/real/secret`, foldCase: false },
		});
		await flush(DEADLINE * 2);
		expect((await after).action).toBe("allow");
	});

	it("an eager fill that misses at 250 ms neither terminates nor trips the breaker, and the late answer is stored (R3-H1)", async () => {
		const transports: FixtureTransport[] = [];
		const resolver = resolverWith({
			delayMs: (request) => (request.kind === "canonicalizeRule" ? 300 : 0),
			transports,
		});
		const { service: s } = service([deny(`${root}/link/secret`)], resolver);
		await flush(RULE_FILL_DEADLINE_MS);
		expect(s.ruleIdentityState(`${root}/link/secret`)).toBe("pending");
		await flush(100);
		expect(s.ruleIdentityState(`${root}/link/secret`)).toMatchObject({ prefix: `${real}/real/secret` });
		expect(transports[0]?.terminated.count).toBe(0);
		expect(resolver.breakerState(resolver.volumeKey(root))).toBe("closed");
		const decision = decide(s, "read", `${real}/real/secret`);
		await flush(300);
		expect((await decision).action).toBe("deny");
	});

	it("FP costs latency only: a volume type outside the allowlist with a healthy resolver decides exactly as an allowlisted one (R7)", async () => {
		const smb = parseMountTable(`/dev/disk1 on / (apfs, local)\n//server/share on ${real} (smbfs, nodev)`, "darwin");
		const transports: FixtureTransport[] = [];
		const resolver = resolverWith({ snapshot: smb, firmlinks: [], transports });
		const { service: s } = service([deny(`${real}/real/secret`), allow(`${real}/plain/*`, "edit")], resolver);
		await flush(RULE_FILL_DEADLINE_MS);
		const alias = resolver.detect(`${real}/plain/p`);
		await flush(0);
		expect(await alias).toBe(true);
		const denied = decide(s, "read", `${real}/real/secret`);
		await flush(DEADLINE);
		expect((await denied).action).toBe("deny");
		const allowed = decide(s, "edit", `${real}/plain/x`);
		await flush(DEADLINE);
		expect((await allowed).action).toBe("allow");
		const plain = decide(s, "read", `${real}/plain/p`);
		await flush(DEADLINE);
		expect((await plain).action).toBe("ask");
	});

	it("FP + a timed-out deny: a plain-spelled request on the non-allowlisted volume is denied; an allowlisted one with a kernel canonical is decided normally", async () => {
		const smb = parseMountTable(
			`/dev/disk1 on / (apfs, local)\n//server/share on ${real}/plain (smbfs, nodev)`,
			"darwin",
		);
		let wedged = false;
		const resolver = resolverWith({
			snapshot: smb,
			firmlinks: [],
			stall: (request) => wedged && request.kind === "canonicalizeRule",
		});
		const { service: s } = service([], resolver);
		void s;
		const stalled = service(
			[deny(`${root}/link/secret`)],
			resolverWith({ snapshot: smb, firmlinks: [], stall: (request) => request.kind === "canonicalizeRule" }),
		);
		await flush(DEADLINE * 3);
		wedged = true;
		const onSmb = decide(stalled.service, "read", `${real}/plain/p`);
		await flush(DEADLINE * 3);
		expect((await onSmb).action).toBe("deny");
		const kernelExact = decide(stalled.service, "read", `${real}/real/dir/f`, {
			canonical: { v: PATH_IDENTITY_VERSION, path: `${real}/real/dir/f`, foldCase: false },
		});
		await flush(DEADLINE * 3);
		expect((await kernelExact).action).toBe("ask");
	});

	it("stale no-alias: an undecided symlink retarget after a healthy decision is denied once the deny is timed out (R5-H1)", async () => {
		let wedged = false;
		const resolver = resolverWith({ stall: (request) => wedged && request.kind === "canonicalizeRule" });
		const { service: s } = service([deny(`${root}/link/secret`)], resolver);
		await flush(RULE_FILL_DEADLINE_MS);
		const healthy = decide(s, "read", `${real}/plain/p`);
		await flush(DEADLINE);
		expect((await healthy).action).toBe("ask");
		rmSync(join(root, "plain", "p"));
		symlinkSync(join(root, "real", "secret"), join(root, "plain", "p"));
		s.noteMutation(`${root}/link`);
		wedged = true;
		const retargeted = decide(s, "read", `${real}/plain/p`);
		await flush(DEADLINE * 3);
		expect((await retargeted).action).toBe("deny");
	});

	it("R.aliasBearing is computed on the worker at rules load and treated as true while pending", async () => {
		const resolver = resolverWith({ delayMs: (request) => (request.kind === "detect" ? 400 : 0) });
		const { service: s } = service([deny(`${real}/real/secret`)], resolver);
		expect(s.ruleAliasBearing(`${real}/real/secret`)).toBe(true);
		await flush(500);
		expect(s.ruleAliasBearing(`${real}/real/secret`)).toBe(false);
		const { service: aliased } = service([deny(`${root}/link/secret`)], resolver);
		await flush(500);
		expect(aliased.ruleAliasBearing(`${root}/link/secret`)).toBe(true);
	});

	it("DeniedError after a timed-out deny names the synthetic pattern through ask()", async () => {
		const resolver = resolverWith({ stall: (request) => request.kind === "canonicalizeRule" });
		const { service: s } = service([deny(`${root}/link/*`)], resolver);
		await flush(DEADLINE * 3);
		const outcome = ask(s, "read", "link/secret", `${root}/link/secret`);
		await flush(DEADLINE * 3);
		const result = await outcome;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("UNKNOWN");
		const direct = expect(
			s.ask(
				{ sessionID: "s", permission: "read", patterns: ["link/secret"], always: [], metadata: {} },
				{ executed: [`${root}/link/secret`] },
			),
		).rejects.toBeInstanceOf(DeniedError);
		await flush(DEADLINE * 3);
		await direct;
	});
});
