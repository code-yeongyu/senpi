import { afterEach, beforeEach, expect, it } from "vitest";
import { confirmOwner, readDarwinEvidence } from "../../../src/core/extensions/builtin/terminal/orphan-reaper.ts";
import { darwinProcessStartMs } from "../../../src/core/extensions/builtin/terminal/process-start-probe.ts";
import { readProcessStarts } from "../../../src/modes/rpc/session-held.ts";
import { fakePs, REPEATED_HOUR_START_MS } from "./12108-fake-ps.ts";

// omo#12108 (senpi side): every reader of `ps -o lstart=` names the start instant of a live process exactly, also when
// it starts in the repeated hour of a daylight-saving fall-back. Read as local time, New York's 01:30 on 2026-11-01 is
// two instants an hour apart, so a reader picks one: a recorder in a zone without that hour and this reader then
// disagree, and a live terminal lease owner reads as stale, a daemon-family member drops out of session admission, and
// an orphan watcher cannot be confirmed. The fake `ps` renders in the timezone its environment names, as `ps` does.
const realTz = process.env.TZ;
beforeEach(() => {
	process.env.TZ = "America/New_York";
});
afterEach(() => {
	if (realTz === undefined) delete process.env.TZ;
	else process.env.TZ = realTz;
});

it("the terminal lease probe reads the exact start of a process started in the repeated hour", async () => {
	const ps = fakePs();

	expect(await darwinProcessStartMs(4242, ps.run)).toBe(REPEATED_HOUR_START_MS);
});

it("the session admission snapshot reads the exact start of a process started in the repeated hour", async () => {
	const ps = fakePs(REPEATED_HOUR_START_MS, "4242 ");

	const starts = await readProcessStarts((command, args, options) => ps.run(command, args, options.env));

	expect(starts?.get(4242)).toBe(REPEATED_HOUR_START_MS);
});

const watcher = {
	pid: 4242,
	startedAtMs: REPEATED_HOUR_START_MS,
	bootAtMs: 1_000,
	argv: ["/bin/sh", "-c", "tail -F build.log"],
};
const darwinOwner = (read: (pid: number) => ReturnType<typeof readDarwinEvidence>) =>
	confirmOwner(watcher, undefined, {
		platform: "darwin",
		isProcessAlive: () => true,
		bootAtMs: async () => watcher.bootAtMs,
		readProcessEvidence: read,
	});

it("the orphan reaper confirms its live watcher started in the repeated hour", async () => {
	const ps = fakePs(REPEATED_HOUR_START_MS, "", ` ${watcher.argv.join(" ")}`);

	expect(await darwinOwner((pid) => readDarwinEvidence(pid, ps.run))).toBe("confirmed");
});

it("the orphan reaper never confirms, so never kills, a watcher whose start it cannot read", async () => {
	expect(await darwinOwner(async () => ({ argv: watcher.argv.join(" ") }))).toBe("unverifiable");
});
