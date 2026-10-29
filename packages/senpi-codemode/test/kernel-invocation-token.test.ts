import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JavaScriptKernel, revokeSessionKernels } from "../src/kernels/js/context-manager.ts";
import type { CellPermissionState } from "../src/kernels/js/kernel-contract.ts";
import { KernelPermissionHost } from "../src/kernels/js/permission-host.ts";
import { invocationSession } from "../src/kernels/shared/invocation-authority.ts";

// #4309: the host-minted token, not caller arguments, chooses the permission session and cwd.
describe("kernel invocation tokens", () => {
	it("keeps a settled cross-session continuation alive yet revocable by its invoker", async () => {
		const root = await mkdtemp(join(tmpdir(), "invoker-continuation-"));
		const invokerId = crypto.randomUUID();
		let invoker: CellPermissionState = { epoch: 1, active: false, rules: [] };
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: root,
			parallelPoolWidth: 2,
			permissions: {
				state: () => ({ epoch: 1, active: false, rules: [] }),
				resolveSession: (sessionId) =>
					sessionId === invokerId
						? { cwd: root, state: invoker }
						: { cwd: root, state: { epoch: 0, active: false, rules: [] } },
				decide: () => ({ action: "deny", rule: { permission: "write", pattern: "*", layer: "user" } }),
			},
		});
		const run = (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 8_000 });
		const schedule = async (name: string) => {
			const entry = (await kernel.describeKernelTools(["schedule"])).results[0];
			if (!entry?.ok) throw new Error("missing schedule descriptor");
			await kernel.invokeKernelTool(
				{ ...entry.descriptor, args: { name }, call_id: crypto.randomUUID() },
				{ invoker: { sessionId: invokerId } },
			);
		};
		try {
			expect(
				await run(`var gates = {}; var results = {};
				tool(function schedule(name) {
					gates[name] = Promise.withResolvers();
					results[name] = gates[name].promise.then(() => {
						try { require("node:fs").writeFileSync(${JSON.stringify(root)} + "/" + name, "ok"); return "wrote"; }
						catch (error) { return error.code; }
					});
					return name;
				});`),
			).toMatchObject({ ok: true });
			// No session enforces: the settled invocation's continuation keeps working, as before the core.
			await schedule("parity");
			expect(await run(`gates.parity.resolve(); return await results.parity;`)).toMatchObject({
				ok: true,
				valueRepr: '"wrote"',
			});
			expect(existsSync(join(root, "parity"))).toBe(true);
			// The invoker then starts enforcing: its revocation still reaches the continuation it left behind.
			await schedule("revoked");
			invoker = { epoch: 2, active: true, rules: [{ permission: "write", pattern: "*", layer: "user" }] };
			await revokeSessionKernels(invokerId);
			await run(`gates.revoked?.resolve(); return await results.revoked;`);
			expect(existsSync(join(root, "revoked"))).toBe(false);
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ name: "owner", ownerActive: true, invokerActive: false, enforcingSessionId: "owner" },
		{ name: "invoker", ownerActive: false, invokerActive: true, enforcingSessionId: "invoker" },
		{ name: "both", ownerActive: true, invokerActive: true, enforcingSessionId: "owner" },
	])(
		"identifies the cross-session barrier when $name enforces",
		({ ownerActive, invokerActive, enforcingSessionId }) => {
			const rule = { permission: "bash", pattern: "unrelated-command", layer: "user" };
			const snapshot = (active: boolean) => ({
				cwd: "/work",
				state: { epoch: 1, active, rules: active ? [rule] : [] },
			});
			expect(() =>
				invocationSession("owner", snapshot(ownerActive), { invoker: { sessionId: "invoker" } }, () =>
					snapshot(invokerActive),
				),
			).toThrowError(
				expect.objectContaining({
					code: "cell_permission_denied",
					reason: "cross_session_authority",
					enforcingSessionId,
					rule,
				}),
			);
		},
	);

	it("drops an invoker binding once its retained continuation ends", async () => {
		const invokerId = `invoker-${crypto.randomUUID()}`;
		const retired: string[] = [];
		const makeHost = () =>
			new KernelPermissionHost(
				{
					sessionId: `owner-${crypto.randomUUID()}`,
					cwd: "/owner",
					parallelPoolWidth: 2,
					permissions: {
						state: () => ({ epoch: 1, active: false, rules: [] }),
						resolveSession: () => ({ cwd: "/invoker", state: { epoch: 2, active: false, rules: [] } }),
						decide: () => ({ action: "pass" }),
					},
				},
				async () => {
					retired.push("retired");
					return "terminated";
				},
			);
		const request = {
			name: "probe",
			kernel_generation: 1,
			definition_revision: 1,
			args: {},
			call_id: crypto.randomUUID(),
		};
		// A settled no-deny continuation is still live, so its invoker keeps reaching it (#4390).
		const retaining = makeHost();
		try {
			retaining.invocation(request, { invoker: { sessionId: invokerId } })();
			await revokeSessionKernels(invokerId);
			expect(retired).toHaveLength(1);
		} finally {
			await retaining.terminateChildren();
			retaining.dispose();
		}
		// Once that continuation is gone, the binding is given back instead of waiting for retirement.
		retired.length = 0;
		const ended = makeHost();
		try {
			ended.invocation(request, { invoker: { sessionId: invokerId } })();
			ended.frame({ type: "close" });
			await revokeSessionKernels(invokerId);
			expect(retired).toHaveLength(0);
		} finally {
			await ended.terminateChildren();
			ended.dispose();
		}
	});

	it("mints owner tokens for absent/same invokers and invoking-session tokens otherwise", async () => {
		const host = new KernelPermissionHost(
			{
				sessionId: "token-owner",
				cwd: "/owner",
				parallelPoolWidth: 2,
				permissions: {
					state: () => ({ epoch: 1, active: false, rules: [] }),
					resolveSession: () => ({
						cwd: "/invoker",
						state: { epoch: 2, active: false, rules: [] },
					}),
					decide: () => ({ action: "pass" }),
				},
			},
			async () => "terminated",
		);
		const signal = new AbortController().signal;
		const request = {
			name: "probe",
			kernel_generation: 1,
			definition_revision: 1,
			args: { invoker: { sessionId: "forged" } },
			call_id: "probe",
		};
		try {
			for (const invoker of [undefined, { sessionId: "token-owner" }, { sessionId: "token-invoker" }]) {
				const token = host.resolveInvocationToken(request, { signal, invoker });
				expect(token).toMatchObject({
					sessionId: invoker?.sessionId ?? "token-owner",
					cwd: invoker?.sessionId === "token-invoker" ? "/invoker" : "/owner",
					signal,
				});
				expect(Atomics.load(new Int32Array(token.authority), 0)).toBe(
					invoker?.sessionId === "token-invoker" ? 10 : 6,
				);
			}
		} finally {
			await host.terminateChildren();
			host.dispose();
		}
	});
});
