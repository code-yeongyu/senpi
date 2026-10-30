/**
 * senpi#3246: a host session's drain that keeps failing reports once, not on every wake, until a pass
 * succeeds again (the same limit the terminal endpoint applies).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { HostSessionControl } from "../../../src/modes/rpc/host-session-control.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeSession(): AgentSession {
	const session = {
		extensionRunner: { emit: async () => undefined },
		subscribe: () => () => {},
		externalAdmission: { onEmitted: () => () => {} },
	};
	return session as unknown as AgentSession;
}

describe.skipIf(process.platform === "win32")("senpi#3246 host session drain failures", () => {
	it("#given a drain that keeps failing #when wakes repeat #then one report shows until a pass succeeds again", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-3246-rpc-"));
		roots.push(root);
		const reports: string[] = [];
		const control = new HostSessionControl(fakeSession(), join(root, "host.sock"), (line) => reports.push(line));
		let failing = true;
		const registration = await control.register({
			inboxDir: join(root, "inbox"),
			drain: () => {
				if (failing) throw new Error("inbox store unreadable");
				return undefined;
			},
		});
		expect(registration.status).toBe("registered");
		for (let wake = 0; wake < 3; wake += 1) await control.wake();
		const whileFailing = reports.filter((line) => line.includes("drain failed")).length;
		failing = false;
		await control.wake();
		failing = true;
		await control.wake();
		control.dispose();

		expect({ whileFailing, afterRecovery: reports.filter((line) => line.includes("drain failed")).length }).toEqual({
			whileFailing: 1,
			afterRecovery: 2,
		});
	});
});
