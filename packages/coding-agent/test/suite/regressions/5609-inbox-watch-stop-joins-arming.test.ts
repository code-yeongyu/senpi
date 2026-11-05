/**
 * senpi#5609: stopping an inbox watch (directly, or through a host session's `dispose`) used to return
 * while the arming loop's sentinel write and removal were still in flight, so a teardown that removed the
 * inbox's tree right after raced them (ENOTEMPTY). Stopping now settles only after the loop's last
 * sentinel operation has: nothing the watch does reaches the inbox after the stop resolves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { watchInbox } from "../../../src/modes/interactive/session-control-wake.ts";
import { HostSessionControl } from "../../../src/modes/rpc/host-session-control.ts";

const probe = vi.hoisted(() => ({ events: [] as string[], removed: Promise.withResolvers<void>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const isSentinel = (path: unknown): boolean => basename(String(path)).startsWith(".senpi-armed-");
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			try {
				return await actual.writeFile(...args);
			} finally {
				if (isSentinel(args[0])) probe.events.push("sentinel write settled");
			}
		},
		rm: async (...args: Parameters<typeof actual.rm>) => {
			try {
				return await actual.rm(...args);
			} finally {
				if (isSentinel(args[0])) {
					probe.events.push("sentinel removed");
					probe.removed.resolve();
				}
			}
		},
	};
});

const roots: string[] = [];

beforeEach(() => {
	probe.events.length = 0;
	probe.removed = Promise.withResolvers<void>();
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-5609-"));
	roots.push(root);
	return root;
}

function fakeSession(): AgentSession {
	const session = {
		extensionRunner: { emit: async () => undefined },
		subscribe: () => () => {},
		externalAdmission: { onEmitted: () => () => {} },
	};
	return session as unknown as AgentSession;
}

/** What the watch did after the stop resolved, once its arming loop is known to have ended. */
async function afterStop(marker: string): Promise<string[]> {
	probe.events.push(marker);
	await probe.removed.promise;
	return probe.events.slice(probe.events.indexOf(marker) + 1);
}

describe.skipIf(process.platform === "win32")("senpi#5609 inbox watch stop joins its arming loop", () => {
	it("#given an inbox watch still arming #when it is stopped #then no sentinel operation settles after the stop resolves", async () => {
		const inboxDir = join(scratch(), "inbox");
		const watch = await watchInbox(
			inboxDir,
			() => {},
			() => {},
		);

		await watch.stop();

		expect(await afterStop("stopped")).toEqual([]);
	});

	it("#given a host session registration still arming #when the host is disposed #then nothing reaches the inbox after dispose resolves", async () => {
		const root = scratch();
		const control = new HostSessionControl(fakeSession(), join(root, "host.sock"), () => {});
		const registration = await control.register({ inboxDir: join(root, "inbox"), drain: () => undefined });
		expect(registration.status).toBe("registered");

		await control.dispose();

		expect(await afterStop("disposed")).toEqual([]);
	});
});
