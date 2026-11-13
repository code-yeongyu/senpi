import { describe, expect, it, vi } from "vitest";
import type { CellPermissionState } from "../src/kernels/js/kernel-contract.ts";

// omo#12965 (design amendment 3.2-A1): a realm can hold more than one copy of the codemode extension (Node re-evaluates
// an extension on every load, and a module generation can be replaced while sessions live). Two of its tables are
// looked up by session id across sessions: the invoker's cell permission state, and the kernels a session revocation
// must reach. A copy that cannot see what another copy registered must refuse, never admit. `vi.resetModules()`
// between the imports gives copy B its own module graph in the same realm.

async function twoCopies<T>(load: () => Promise<T>): Promise<[T, T]> {
	const a = await load();
	vi.resetModules();
	const b = await load();
	return [a, b];
}

/** A member of the realm's registry, called the way a copy that knows only the key would call it. */
function callRegistry(member: string, ...args: unknown[]): unknown {
	const registry: unknown = Reflect.get(globalThis, Symbol.for("@code-yeongyu/senpi/codemode-cell-authority/v1"));
	const fn: unknown = typeof registry === "object" && registry !== null ? Reflect.get(registry, member) : undefined;
	if (typeof fn !== "function") throw new Error(`no codemode cell-authority registry member ${member} in this realm`);
	return Reflect.apply(fn, registry, args);
}

const inactive: CellPermissionState = { epoch: 0, active: false, rules: [] };
const denying: CellPermissionState = {
	epoch: 1,
	active: true,
	rules: [{ permission: "write", pattern: "*", layer: "user" }],
};

describe("codemode cross-session permission state across two copies (omo#12965)", () => {
	const authority = async () => import("../src/kernels/shared/invocation-authority.ts");

	it("refuses a cross-session kernel tool whose invoker registered its deny rules through another copy", async () => {
		const [a, b] = await twoCopies(authority);
		expect(a.invocationSession).not.toBe(b.invocationSession);
		const release = a.registerInvocationSession("x12965-denying-invoker", () => ({
			cwd: "/invoker",
			state: denying,
		}));

		const invoke = () =>
			b.invocationSession(
				"x12965-owner-1",
				{ cwd: "/owner", state: inactive },
				{ invoker: { sessionId: "x12965-denying-invoker" } },
			);

		expect(invoke).toThrow(
			"Cross-session kernel tool refused while session x12965-denying-invoker enforces deny rules",
		);
		release();
	});

	it("admits a cross-session kernel tool whose invoker another copy registered without deny rules", async () => {
		const [a, b] = await twoCopies(authority);
		const release = a.registerInvocationSession("x12965-open-invoker", () => ({ cwd: "/invoker", state: inactive }));

		const session = b.invocationSession(
			"x12965-owner-2",
			{ cwd: "/owner", state: inactive },
			{ invoker: { sessionId: "x12965-open-invoker" } },
		);

		expect(session).toEqual({ sessionId: "x12965-open-invoker", cwd: "/invoker", state: inactive });
		release();
	});

	it("revokes and retires a session's kernels that another copy registered", async () => {
		const [a, b] = await twoCopies(async () => import("../src/kernels/js/permission-sessions.ts"));
		expect(a.revokeSessionKernels).not.toBe(b.revokeSessionKernels);
		const calls: string[] = [];
		const kernel = {
			revoke: () => calls.push("revoke"),
			retire: async () => {
				calls.push("retire");
			},
		};
		a.registerPermissionKernel("x12965-revoked", kernel);

		await b.revokeSessionKernels("x12965-revoked");

		expect(calls).toEqual(["revoke", "retire"]);
		a.unregisterPermissionKernel("x12965-revoked", kernel);
	});

	// The registered state is read on every cross-session call, as one copy always has, so the hook's answer does not
	// make an unreadable snapshot readable.
	const hookAnswer = (): { cwd: string; state: CellPermissionState } => ({ cwd: "/hook", state: inactive });
	it.each<[string, typeof hookAnswer | undefined]>([
		["with no hook", undefined],
		["when the hook answers", hookAnswer],
	])(
		"refuses a cross-session kernel tool when the invoker's registered state cannot be read, %s",
		async (_label, hook) => {
			const [, b] = await twoCopies(authority);
			const id = `x12965-unreadable-invoker-${hook ? "hooked" : "plain"}`;
			// A snapshot from a version that no longer carries `active`: read as is, it would look like no enforcement.
			const release = callRegistry("registerInvocation", id, () => ({
				cwd: "/invoker",
				state: { epoch: 1, enforcing: true, rules: [{ permission: "write", pattern: "*", layer: "user" }] },
			}));

			const invoke = () =>
				b.invocationSession(
					"x12965-owner-3",
					{ cwd: "/owner", state: inactive },
					{ invoker: { sessionId: id } },
					hook,
				);

			expect(invoke).toThrow(
				expect.objectContaining({
					message: "Cross-session kernel tool refused: permission authority unavailable",
					code: "cell_permission_denied",
					enforcingSessionId: id,
				}),
			);
			if (typeof release === "function") release();
		},
	);

	it.each([
		["revoke", { retire: async () => {} }],
		["retire", { revoke: () => {} }],
	])("refuses to register a kernel it could not %s", async (missing, kernel) => {
		await twoCopies(async () => import("../src/kernels/js/permission-sessions.ts"));

		expect(() => callRegistry("registerKernel", `x12965-no-${missing}`, kernel)).toThrow(
			"Permission authority unavailable",
		);
	});

	it.each(["revoke", "retire"] as const)(
		"revokes and retires every kernel of a session when one of them throws in %s, and leaves the session dead",
		async (failsIn) => {
			const [a, b] = await twoCopies(async () => import("../src/kernels/js/permission-sessions.ts"));
			const id = `x12965-throws-in-${failsIn}`;
			const calls: string[] = [];
			const kernel = (name: string, fails: boolean) => ({
				revoke: () => {
					calls.push(`${name}.revoke`);
					if (fails && failsIn === "revoke") throw new Error(`${name} cannot revoke`);
				},
				retire: () => {
					calls.push(`${name}.retire`);
					if (fails && failsIn === "retire") throw new Error(`${name} cannot retire`);
					return Promise.resolve();
				},
			});
			const [first, failing, last] = [kernel("first", false), kernel("failing", true), kernel("last", false)];
			const session = a.registerPermissionKernel(id, first);
			a.registerPermissionKernel(id, failing);
			b.registerPermissionKernel(id, last);

			await expect(b.revokeSessionKernels(id)).rejects.toThrow(`failing cannot ${failsIn}`);

			expect(calls).toEqual([
				"first.revoke",
				"failing.revoke",
				"last.revoke",
				"first.retire",
				"failing.retire",
				"last.retire",
			]);
			expect(session.dead).toBe(true);
			for (const [copy, registered] of [
				[a, first],
				[a, failing],
				[b, last],
			] as const) {
				copy.unregisterPermissionKernel(id, registered);
			}
		},
	);

	it("shows a session another copy marked dead to a kernel that binds to it", async () => {
		const [a, b] = await twoCopies(async () => import("../src/kernels/js/permission-sessions.ts"));
		const first = { revoke: () => {}, retire: async () => {} };
		const second = { revoke: () => {}, retire: async () => {} };
		const session = a.registerPermissionKernel("x12965-dead", first);
		session.dead = true;
		const seenByOtherCopy = b.registerPermissionKernel("x12965-dead", second);
		// Nothing revives a dead session: the handle offers no way back.
		seenByOtherCopy.dead = false;

		expect({ a: session.dead, b: seenByOtherCopy.dead }).toEqual({ a: true, b: true });
		a.unregisterPermissionKernel("x12965-dead", first);
		b.unregisterPermissionKernel("x12965-dead", second);
	});
});

// The answer rule is the one a single copy has always had; these cases pin it so the registry cannot change it.
describe("which session answers for a cross-session invoker (omo#12965)", () => {
	interface Session {
		readonly cwd: string;
		readonly state: CellPermissionState;
	}
	const hookSession: Session = { cwd: "/hook", state: inactive };
	const enforcing = (): Session => ({ cwd: "/enforcing", state: denying });
	const open = (cwd: string) => (): Session => ({ cwd, state: inactive });

	async function answer(
		invokerId: string,
		readers: readonly (() => Session)[],
		hook?: () => unknown,
	): Promise<unknown> {
		const authority = await import("../src/kernels/shared/invocation-authority.ts");
		// A hook outside this copy's types may answer null; the method form accepts it without a cast.
		const untyped: { invoke(...args: unknown[]): unknown } = { invoke: authority.invocationSession };
		const releases = readers.map((read) => authority.registerInvocationSession(invokerId, read));
		try {
			const owner = { cwd: "/owner", state: inactive };
			return untyped.invoke(`${invokerId}-owner`, owner, { invoker: { sessionId: invokerId } }, hook);
		} catch (error) {
			return error instanceof Error ? error.message : error;
		} finally {
			for (const release of releases) release();
		}
	}

	it("takes the hook's answer over a registered kernel that enforces", async () => {
		expect(await answer("x12965-hook-answers", [enforcing], () => hookSession)).toEqual({
			sessionId: "x12965-hook-answers",
			...hookSession,
		});
	});

	it("keeps the id the dispatcher stamped when the hook's answer carries a session id", async () => {
		expect(await answer("x12965-hook-id", [], () => ({ ...hookSession, sessionId: "x12965-someone-else" }))).toEqual({
			sessionId: "x12965-hook-id",
			...hookSession,
		});
	});

	it.each([
		["null", () => null],
		["undefined", () => undefined],
	])("leaves the answer to the registered kernels when the hook returns %s", async (label, hook) => {
		const id = `x12965-hook-${label}`;
		expect(await answer(id, [enforcing], hook)).toBe(
			`Cross-session kernel tool refused while session ${id} enforces deny rules, including write * (user)`,
		);
	});

	it("lets an enforcing kernel win over one registered before it that does not enforce", async () => {
		expect(await answer("x12965-active-wins", [open("/first"), enforcing])).toBe(
			"Cross-session kernel tool refused while session x12965-active-wins enforces deny rules, including write * (user)",
		);
	});

	it("keeps a session's newer registration when an older release closure is called again", async () => {
		const authority = await import("../src/kernels/shared/invocation-authority.ts");
		const id = "x12965-stale-release";
		const releaseOlder = authority.registerInvocationSession(id, open("/older"));
		releaseOlder();
		const releaseNewer = authority.registerInvocationSession(id, enforcing);
		releaseOlder();

		expect(await answer(id, [])).toBe(
			`Cross-session kernel tool refused while session ${id} enforces deny rules, including write * (user)`,
		);
		releaseNewer();
	});

	it("takes the first registered kernel when none enforces", async () => {
		expect(await answer("x12965-first-wins", [open("/first"), open("/second")])).toEqual({
			sessionId: "x12965-first-wins",
			cwd: "/first",
			state: inactive,
		});
	});
});
