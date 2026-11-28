import { afterEach, expect, it } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

it.each(["terminal-background-sessions", "terminal-monitors", "senpi-codemode"])(
	"reports the current %s count to a client that did not see the transition",
	async (source) => {
		let publish: ((count: number) => void) | undefined;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					publish = (activeCount) => pi.events.emit(WAKE_SOURCE_STATE_EVENT, { source, activeCount });
				},
			],
		});
		await harness.session.bindExtensions({ mode: "rpc" });
		if (!publish) throw new Error("fixture extension was not bound");
		publish(2);
		expect(harness.session.isSessionBusy).toBe(true);
		expect(buildRpcSessionState(harness.session)).toMatchObject({
			activity: { busy: true, wakeSources: { [source]: 2 } },
		});
		publish(0);
		expect(harness.session.isSessionBusy).toBe(false);
		expect(buildRpcSessionState(harness.session).activity).toEqual({ busy: false, wakeSources: {} });
	},
);
