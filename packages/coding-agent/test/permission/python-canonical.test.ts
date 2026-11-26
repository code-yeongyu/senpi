import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startBridgeServer } from "../../../senpi-codemode/src/bridge/http-server.ts";
import { permissionCheck, registerPermissionCheck } from "../../../senpi-codemode/src/bridge/permission-check.ts";
import { createInterpreterDetector } from "../../../senpi-codemode/src/interpreters/detect.ts";
import { PythonKernel } from "../../../senpi-codemode/src/kernels/py/kernel.ts";
import { createCellDecision } from "../../src/core/extensions/builtin/permission-system/cell-decision.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PATH_IDENTITY_VERSION } from "../../src/core/extensions/builtin/permission-system/path-identity.ts";
import { createPathIdentityResolver } from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";

// #4392: the fixture decider recomputed missing identities and hid this real-service failure.
it("enforces a path deny on a Python symlink read while the resolver is unavailable", async () => {
	const python = await createInterpreterDetector().detect("py");
	if (!python.ok) throw new Error("Python is required for permission enforcement tests");
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "python-canonical-")));
	const resolver = createPathIdentityResolver({
		spawn: () => {
			throw new Error("resolver startup unavailable");
		},
		fatal: () => {},
		log: () => {},
	});
	let kernel: PythonKernel | undefined;
	let server: Awaited<ReturnType<typeof startBridgeServer>> | undefined;
	let service: PermissionService | undefined;
	try {
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "secret"), "SECRET");
		writeFileSync(join(root, "real", "public"), "PUBLIC");
		symlinkSync(join(root, "real"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		const rule = { permission: "read", pattern: `${root}/real/secret`, action: "deny" as const };
		service = new PermissionService([rule], [], undefined, "full-access", root, undefined, resolver);
		await service.identitySettled();
		expect(resolver.unavailable).toBeDefined();
		const decide = createCellDecision(
			() => ({
				service: service ?? null,
				parsers: createBuiltinParserRegistry(),
				preset: "full-access",
				setupError: null,
			}),
			() => undefined,
		);
		server = await startBridgeServer({
			onCall: async () => null,
			onEmit: async () => {},
			onCompletion: async () => null,
		});
		kernel = await PythonKernel.start({
			interpreterPath: python.path,
			sessionId: crypto.randomUUID(),
			cwd: root,
			connection: { port: server.port, token: server.token },
			memory: { gcWatermarkBytes: 0, noticeBytes: 0, ceilingBytes: 0 },
			permissions: {
				state: () => ({ epoch: 1, active: true, rules: [{ ...rule, layer: "user" }] }),
				decide: (_token, call) => decide({ ...call, cwd: call.cwd ?? root }),
			},
		});
		const allowed = await kernel.run({
			cellId: "allowed",
			code: "with open('link/public') as f:\n    print(f.read())",
			timeoutMs: 20_000,
		});
		expect(allowed.ok).toBe(true);
		const denied = await kernel.run({
			cellId: "denied",
			code: "with open('link/secret') as f:\n    print(f.read())",
			timeoutMs: 20_000,
		});
		expect(denied).toMatchObject({ ok: false, error: { code: "cell_permission_denied" } });
		const token = crypto.randomUUID();
		const release = registerPermissionCheck(token, async (call) => decide({ ...call, cwd: call.cwd ?? root }));
		try {
			const canonical = { v: PATH_IDENTITY_VERSION, path: rule.pattern, foldCase: false };
			for (const [candidate, action] of [
				[canonical, "deny"],
				[{ ...canonical, v: PATH_IDENTITY_VERSION + 1 }, "pass"],
				[{ ...canonical, v: String(PATH_IDENTITY_VERSION) }, "pass"],
				[{ ...canonical, path: 42 }, "pass"],
				[{ ...canonical, foldCase: "false" }, "pass"],
				[null, "pass"],
			]) {
				expect(
					await permissionCheck({
						token,
						nonce: "validation",
						call: {
							tool: "read",
							cwd: root,
							input: { path: "link/secret", executedPath: `${root}/link/secret`, canonical: candidate },
						},
					}),
					JSON.stringify(candidate),
				).toMatchObject({ nonce: "validation", decision: { action } });
			}
		} finally {
			release();
		}
	} finally {
		await kernel?.close();
		await server?.close();
		service?.dispose();
		await resolver.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
