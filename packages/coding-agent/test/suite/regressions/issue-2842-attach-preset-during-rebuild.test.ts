/**
 * #2842: an attach that names a stricter `permissionPreset` while its session is being rebuilt (a
 * reload, or a new / switch / fork / import replacement) is enforced by the session that comes out
 * of the rebuild, and a resent attach repairs a live session that drifted from its recorded preset.
 *
 * Each race parks the rebuild at an await the production code already makes
 * (`attach-permission-preset-harness.ts`), lands the attach there, then releases the rebuild: the
 * order is fixed by events, not by timing.
 */
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachHost, disposeAttachHosts, type Hold, sessionIdOf } from "./attach-permission-preset-harness.ts";

afterEach(disposeAttachHosts);

type Host = Awaited<ReturnType<typeof attachHost>>;

/** Starts `rebuild`, attaches from the second client (with `ask` by default) while it is parked, then lets it finish. */
async function attachDuring(
	host: Host,
	sessionId: string,
	hold: Hold,
	rebuild: Record<string, unknown>,
	attach = () => host.open("second", "ask"),
) {
	const rebuilding = host.send("first", { ...rebuild, sessionId });
	try {
		await hold.reached;
		expect((await attach())?.data).toMatchObject({ sessionId, attached: true });
	} finally {
		hold.release();
	}
	expect(await rebuilding).toMatchObject({ success: true, data: { cancelled: false } });
}

describe("an attach that lands during a rebuild of its session is enforced afterwards (#2842)", () => {
	it("a reload", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "full-access"));
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });

		await attachDuring(host, sessionId, host.holdNextReload(), { type: "reload" });
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });
	}, 120_000);

	it("two overlapping reloads, with the attach landing after the second one swapped its runner", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "full-access"));
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });

		// The first reload parks in its session_shutdown; a second one runs to completion and installs a
		// new runner; the attach writes that runner; then the first reload swaps in its own runner.
		const hold = host.holdNextReload();
		const firstReload = host.send("first", { type: "reload", sessionId });
		try {
			await hold.reached;
			expect(await host.send("first", { type: "reload", sessionId })).toMatchObject({
				success: true,
				data: { cancelled: false },
			});
			expect((await host.open("second", "ask"))?.data).toMatchObject({ sessionId, attached: true });
		} finally {
			hold.release();
		}
		expect(await firstReload).toMatchObject({ success: true, data: { cancelled: false } });
		expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });
	}, 120_000);

	it.each([
		["new_session", () => ({ type: "new_session" })],
		[
			"switch_session",
			(host: Host) => ({ type: "switch_session", sessionPath: host.otherPath, cwdOverride: host.cwd }),
		],
		["clone (fork)", () => ({ type: "clone" })],
		[
			"import_jsonl",
			async (host: Host) => {
				const inputPath = join(dirname(host.threadPath), "import-source.jsonl");
				await copyFile(host.threadPath, inputPath);
				return { type: "import_jsonl", inputPath, cwdOverride: host.cwd };
			},
		],
	])(
		"a %s replacement",
		async (_name, rebuild: (host: Host) => Record<string, unknown> | Promise<Record<string, unknown>>) => {
			const host = await attachHost();
			const sessionId = sessionIdOf(await host.open("first", "full-access"));
			expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });

			await attachDuring(host, sessionId, host.holdNextReplacement(), await rebuild(host));
			expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });
		},
		120_000,
	);
});

it("a resent attach repairs a live session that drifted from its recorded preset (#2842)", async () => {
	const host = await attachHost();
	const sessionId = sessionIdOf(await host.open("first", "ask"));
	expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });

	// The drift a lost attach used to leave: the record says ask, the live session enforces full-access.
	host.registry.peek(sessionId)?.runtime?.session.extensionRunner.setFlagValue("permission-preset", "full-access");
	expect(await host.runBash(sessionId)).toMatchObject({ asked: 0, ran: true });

	expect((await host.open("second", "ask"))?.data).toMatchObject({ sessionId, attached: true });
	expect(await host.runBash(sessionId)).toMatchObject({ asked: 1, ran: false });
}, 120_000);

it("an attach that moves the prompt surface and browser engine during a replacement is kept by the replacement (#2842)", async () => {
	const host = await attachHost();
	const open = (connection: string, settings: Record<string, unknown>) =>
		host.send(connection, {
			type: "open_session",
			cwd: host.cwd,
			sessionPath: host.threadPath,
			retain_on_disconnect: true,
			permissionPreset: "full-access",
			...settings,
		});
	const sessionId = sessionIdOf(await open("first", { promptSurface: "terminal", browserEngine: "none" }));
	await host.runBash(sessionId);
	expect(host.lastTurnSettings()).toEqual({ promptSurface: "terminal", browserEngine: "none" });

	await attachDuring(host, sessionId, host.holdNextReplacement(), { type: "new_session" }, () =>
		open("second", { promptSurface: "app", browserEngine: "builtin" }),
	);
	await host.runBash(sessionId);
	expect(host.lastTurnSettings()).toEqual({ promptSurface: "app", browserEngine: "builtin" });
}, 120_000);
