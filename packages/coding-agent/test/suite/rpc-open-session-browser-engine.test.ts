import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

const PRINT_ENGINE = `printf "engine=%s bsk=%s" "\${OMO_BROWSER_ENGINE-unset}" "\${BSK_HOME-unset}"`;

afterEach(() => {
	vi.unstubAllEnvs();
});

it("gives each session its own OMO_BROWSER_ENGINE in its tool subprocess, and none to a session that chose nothing", async () => {
	await using host = await contextHost();

	const connected = await host.open("conn-a", { browserEngine: "connected" });
	const builtin = await host.open("conn-b", { browserEngine: "builtin" });
	const none = await host.open("conn-c", { browserEngine: "none" });
	const unchosen = await host.open("conn-d", {});

	expect(await host.bashOutput(String(connected.sessionId), PRINT_ENGINE)).toContain("engine=connected");
	expect(await host.bashOutput(String(builtin.sessionId), PRINT_ENGINE)).toContain("engine=builtin");
	expect(await host.bashOutput(String(none.sessionId), PRINT_ENGINE)).toContain("engine=none");
	expect(await host.bashOutput(String(unchosen.sessionId), PRINT_ENGINE)).toContain("engine=unset");
	expect(await host.bashOutput(String(connected.sessionId), PRINT_ENGINE)).toContain("engine=connected");
}, 120_000);

it("passes BSK_HOME from the host process to every session unchanged", async () => {
	vi.stubEnv("BSK_HOME", "/opt/bsk-home");
	await using host = await contextHost();

	const unchosen = await host.open("conn-a", {});
	const builtin = await host.open("conn-b", { browserEngine: "builtin" });

	expect(await host.bashOutput(String(unchosen.sessionId), PRINT_ENGINE)).toBe("engine=unset bsk=/opt/bsk-home");
	expect(await host.bashOutput(String(builtin.sessionId), PRINT_ENGINE)).toBe("engine=builtin bsk=/opt/bsk-home");
}, 120_000);

it("honours browserEngine on a reattach by path, and keeps the engine when the attach names none", async () => {
	await using host = await contextHost();
	const sessionPath = join(host.scratch, "shared.jsonl");
	const first = await host.open("conn-a", { sessionPath, browserEngine: "connected" });
	const sessionId = String(first.sessionId);
	expect(await host.bashOutput(sessionId, PRINT_ENGINE)).toContain("engine=connected");

	const attached = await host.open("conn-b", { sessionPath, browserEngine: "builtin" });
	expect(attached.sessionId).toBe(first.sessionId);
	expect(await host.bashOutput(sessionId, PRINT_ENGINE)).toContain("engine=builtin");

	await host.open("conn-c", { sessionPath });
	expect(await host.bashOutput(sessionId, PRINT_ENGINE)).toContain("engine=builtin");
}, 120_000);

it("refuses a browserEngine that is not connected, builtin or none instead of running without a browser", async () => {
	await using host = await contextHost();

	const error = await host.openFailure("conn-a", { browserEngine: "chrome" });

	expect(error).toContain("browserEngine");
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);

it("advertises browser_engine, the capability a client waits for before sending the field", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(z.array(z.string()).parse(info.capabilities)).toContain("browser_engine");
}, 120_000);
