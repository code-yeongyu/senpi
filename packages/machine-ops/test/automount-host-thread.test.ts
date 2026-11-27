import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	answerAutomountTriggersFrom,
	automountTriggerPath,
	automountTriggerPathSync,
	defaultTriggerView,
	type MountView,
	realpathUnderAutomount,
	refuseUnmountedAutomountPath,
	UNMOUNTED_AUTOMOUNT,
} from "../src/files/automount-trigger.ts";

// senpi#4565: the host thread's synchronous probes ask this check before they touch a path; it reads no filesystem.
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const never = (): Promise<MountView> => new Promise(() => {});
const stuckHelper = () => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1 << 30)"] });
const homeView: MountView = {
	mounts: [
		{ mountPoint: "/", type: "ext4" },
		{ mountPoint: "/automount-home", type: "autofs" },
	],
	aliases: new Map(),
	caseInsensitive: false,
};

describe("automountTriggerPathSync before and after the first mount-table read", () => {
	it("answers a macOS /home, /net and /Network/Servers path from the automounter's default map before any read lands", () => {
		// Given a host whose first mount-table read has not finished
		restores.push(answerAutomountTriggersFrom(never, {}, { platform: "darwin" }));

		// When / Then: the default map's triggers are refused, everything else is left alone
		expect(automountTriggerPathSync("/home/someone/omo-runs/run-a/t4.done")).toBe(
			"/System/Volumes/Data/home/someone/omo-runs/run-a/t4.done",
		);
		expect(automountTriggerPathSync("/HOME/someone/x")).toBeDefined();
		expect(automountTriggerPathSync("/net/build-host/share")).toBeDefined();
		expect(automountTriggerPathSync("/Network/Servers/files/x")).toBeDefined();
		expect(automountTriggerPathSync("/Users/me/project/file.ts")).toBeUndefined();
		expect(automountTriggerPathSync("/tmp/x")).toBeUndefined();
	});

	it("refuses nothing on Linux, before or after the first read, even under an unmounted autofs /home", async () => {
		// Given a Linux host whose /home is an indirect autofs map (a lookup there mounts it) and no read yet
		restores.push(
			answerAutomountTriggersFrom(
				async () => ({
					mounts: [
						{ mountPoint: "/", type: "ext4" },
						{ mountPoint: "/home", type: "autofs" },
					],
					aliases: new Map(),
					caseInsensitive: false,
				}),
				{},
				{ platform: "linux" },
			),
		);
		expect(defaultTriggerView("linux")).toBeUndefined();
		expect(automountTriggerPathSync("/home/me/project/file.ts")).toBeUndefined();

		// When the table has been read
		await automountTriggerPath("/");

		// Then /home is still an ordinary path for the synchronous check, while the async route still knows the trigger
		expect(automountTriggerPathSync("/home/me/project/file.ts")).toBeUndefined();
		expect(() => refuseUnmountedAutomountPath("/home/me/project/file.ts")).not.toThrow();
		expect(await automountTriggerPath("/home/me/project/file.ts")).toBe("/home/me/project/file.ts");
	});

	it("answers from the latest read once it lands, so a trigger that mounted is no longer refused", async () => {
		// Given a view with an unmounted trigger, read once
		let view = homeView;
		restores.push(answerAutomountTriggersFrom(async () => view, {}, { platform: "darwin" }));
		await automountTriggerPath("/");
		expect(automountTriggerPathSync("/automount-home/alice/x")).toBe("/automount-home/alice/x");

		// When the home mounts and the view is read again
		view = { ...homeView, mounts: [...homeView.mounts, { mountPoint: "/automount-home/alice", type: "nfs" }] };
		await automountTriggerPath("/automount-home/alice/x");

		// Then the synchronous check lets it through
		expect(automountTriggerPathSync("/automount-home/alice/x")).toBeUndefined();
	});

	it("throws a typed error for a refused path instead of probing it", async () => {
		restores.push(answerAutomountTriggersFrom(async () => homeView, {}, { platform: "darwin" }));
		await automountTriggerPath("/");
		expect(() => refuseUnmountedAutomountPath("/automount-home/alice/x")).toThrow(
			expect.objectContaining({ code: UNMOUNTED_AUTOMOUNT, path: "/automount-home/alice/x" }),
		);
		expect(() => refuseUnmountedAutomountPath("/srv/x")).not.toThrow();
	});
});

describe("automount resolver helpers are bounded (senpi#4565)", () => {
	it("shares one helper among concurrent requests for the same path", async () => {
		// Given a helper that answers at once
		const spawned: ChildProcess[] = [];
		restores.push(
			answerAutomountTriggersFrom(async () => homeView, {
				command: (path) => ({
					command: process.execPath,
					args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify({ path }))})`],
				}),
				onSpawn: (child) => spawned.push(child),
			}),
		);
		await automountTriggerPath("/");

		// When two calls ask for one path together
		const answers = await Promise.all([
			realpathUnderAutomount("/automount-home/alice/x"),
			realpathUnderAutomount("/automount-home/alice/x"),
		]);

		// Then one helper answered both
		expect(answers).toEqual([
			{ kind: "resolved", path: "/automount-home/alice/x" },
			{ kind: "resolved", path: "/automount-home/alice/x" },
		]);
		expect(spawned).toHaveLength(1);
	});

	it("answers without a spawn once the limit of live helpers is reached", async () => {
		// Given a limit of one and a helper that never answers
		const spawned: ChildProcess[] = [];
		restores.push(
			answerAutomountTriggersFrom(
				async () => homeView,
				{ deadlineMs: 60_000, command: stuckHelper, onSpawn: (child) => spawned.push(child) },
				{ helpers: { limit: 1 } },
			),
		);
		await automountTriggerPath("/");
		const first = realpathUnderAutomount("/automount-home/alice/x");

		// When another automount is asked while that helper lives
		const second = await realpathUnderAutomount("/automount-home/bob/y");

		// Then it is not resolvable now, and nothing was spawned for it
		expect(second).toEqual({ kind: "unanswered", reason: "helper_limit" });
		expect(spawned).toHaveLength(1);
		const exited = once(spawned[0] as ChildProcess, "exit");
		spawned[0]?.kill("SIGKILL");
		await exited;
		await first;
	});

	it("remembers an automount whose helper missed its deadline, on the injected clock, and frees the slot when it exits", async () => {
		// Given a helper blocked in user space (not the kernel case: there a SIGKILL may not end it) and a virtual clock
		let clock = 0;
		const exits: Array<Promise<unknown[]>> = [];
		restores.push(
			answerAutomountTriggersFrom(
				async () => homeView,
				{ deadlineMs: 300, command: stuckHelper, onSpawn: (child) => exits.push(once(child, "exit")) },
				{ helpers: { limit: 1, unansweredForMs: 1_000, now: () => clock } },
			),
		);
		await automountTriggerPath("/");

		// When its helper misses the deadline and is killed
		expect(await realpathUnderAutomount("/automount-home/alice/x")).toEqual({ kind: "unanswered" });
		expect(await exits[0]).toEqual([null, "SIGKILL"]);

		// Then the same automount (another path below it) is answered without a spawn inside the window
		expect(await realpathUnderAutomount("/automount-home/alice/other")).toEqual({
			kind: "unanswered",
			reason: "recently_unanswered",
		});
		expect(exits).toHaveLength(1);

		// And after the window a new helper is tried, the killed one having released its slot
		clock = 1_000;
		expect(await realpathUnderAutomount("/automount-home/alice/x")).toEqual({ kind: "unanswered" });
		expect(exits).toHaveLength(2);
		await exits[1];
	});
});
