import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opportunisticHostGcWithin, trackOpportunisticHostGc } from "../../src/modes/rpc/host-gc-pass-registry.ts";

// senpi#4382: a removal joins the in-flight passes whose `<agentDir>/rpc-host-daemon` lies inside it.
describe("opportunisticHostGcWithin", () => {
	const root = join("/", "scratch", "sg-4615");
	const agentDir = join(root, "a");
	it.each([
		["the scratch root", root, true],
		["the agent directory", agentDir, true],
		["the daemon directory itself", join(agentDir, "rpc-host-daemon"), true],
		["a file inside the daemon directory", join(agentDir, "rpc-host-daemon", "gc-last-run.json"), false],
		["a sibling agent directory", join(root, "b"), false],
		["a sibling whose name starts with two dots", join(root, "..a"), false],
	] as const)("%s -> %s", (_label, target, joined) => {
		let finish = () => {};
		const pass = new Promise<void>((resolve) => {
			finish = resolve;
		});
		trackOpportunisticHostGc(agentDir, pass);
		try {
			expect(opportunisticHostGcWithin(target)).toEqual(joined ? [agentDir] : []);
		} finally {
			finish();
		}
	});

	it("joins a pass whose agent directory name starts with two dots", () => {
		const dotted = join(root, "..a");
		let finish = () => {};
		trackOpportunisticHostGc(
			dotted,
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		try {
			expect(opportunisticHostGcWithin(root)).toContain(dotted);
		} finally {
			finish();
		}
	});
});
