import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashServerUrl } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

it("publishes the first OAuth catalog after legacy migration establishes its credential identity", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const root = makeRoot("2843-first-oauth", cleanup);
	const fixture = await sharingHttpFixture();
	const service = new McpService();
	try {
		const legacyDir = join(root.agentDir, "mcp-auth", hashServerUrl(fixture.url));
		await mkdir(legacyDir, { recursive: true });
		await writeFile(
			join(legacyDir, "tokens.json"),
			JSON.stringify({
				accessToken: "fixture-legacy-account",
				refreshToken: "fixture-refresh",
				expiresAt: Date.now() + 60 * 60 * 1000,
				resource: fixture.url,
			}),
			{ mode: 0o600 },
		);
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "oauth", lifecycle: "eager", exposure: "direct" },
		});
		const pi = capturingPi();
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = AbortSignal.timeout(5000);
			const stop = service.onMcpRegistrationChanged(() => {
				if (!pi.activeTools.includes("mcp_fx_echo")) return;
				stop();
				timeout.removeEventListener("abort", abort);
				resolve();
			});
			const abort = () => {
				stop();
				reject(new Error("First OAuth catalog never published"));
			};
			timeout.addEventListener("abort", abort, { once: true });
		});
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{
				cwd: root.cwd,
				isProjectTrusted: () => true,
			},
			pi,
			{ agentDir: root.agentDir },
		);
		await ready;
		const tool = registeredTool(pi, "mcp_fx_echo");
		const result: Awaited<ReturnType<typeof tool.execute>> = await Reflect.apply(tool.execute, tool, [
			"first-oauth-call",
			{ value: "new catalog" },
			undefined,
			undefined,
		]);
		expect(result).not.toHaveProperty("details.error");
		expect(fixture.calls).toBe(1);
		expect(fixture.callAuthorizations).toEqual(["Bearer fixture-legacy-account"]);
	} finally {
		await service.dispose("quit");
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});
