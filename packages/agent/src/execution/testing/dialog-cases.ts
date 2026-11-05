import { TOOL_RESULT_PLACEHOLDER, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { createCarrierFault, type FaultProfileName, type FaultStats } from "../../transport/testing/fault-transport.ts";
import type { HandPlacement } from "../remote-tool-host.ts";
import { askRemoteDialog, serveDialogPlane, UI_DIALOG_PLANE } from "../remote-ui.ts";
import { call, type HandCaseAdapters, openHandRig } from "./hand-harness.ts";

type DialogCase = CaseImplementation<HandCaseAdapters>;

/**
 * The session's side of a remote dialog in the KILL-DIALOG and FAULT-DIALOG cases: it records each dialog the hand
 * raises, settles one when the case answers it or when the plane aborts it, and refuses an answer to a settled dialog.
 */
function sessionDialogs() {
	const raised: string[] = [];
	const settled: string[] = [];
	const open: Array<((value: boolean | undefined) => void) | undefined> = [];
	const handler = serveDialogPlane(
		(request, signal) =>
			new Promise((resolve) => {
				const index = raised.push(`${request.method}:${String(request.args[0])}`) - 1;
				const finish = (how: string, value: boolean | undefined): void => {
					if (open[index] === undefined) return;
					open[index] = undefined;
					settled[index] = how;
					resolve(value);
				};
				open[index] = (value) => finish("answered", value);
				signal.addEventListener("abort", () => finish("aborted", undefined), { once: true });
			}),
	);
	return {
		planes: { [UI_DIALOG_PLANE]: handler },
		raised,
		settled,
		/** Answers the `index`-th dialog; false when it already settled (a late answer). */
		answer(index: number, value: boolean): boolean {
			const settle = open[index];
			if (settle === undefined) return false;
			settle(value);
			return true;
		},
	};
}

const asking = async (
	adapters: HandCaseAdapters,
	placement: HandPlacement,
	fault?: { readonly profile: FaultProfileName; readonly stats: FaultStats },
) => {
	const dialogs = sessionDialogs();
	const opened = await openHandRig(adapters, {
		placement,
		planes: dialogs.planes,
		...(fault === undefined ? {} : { fault: createCarrierFault(fault.profile, fault.stats) }),
		body: async (handCall) => {
			if (handCall.toolCallId.startsWith("noise")) return { content: [{ type: "text", text: "ran" }], details: {} };
			const outcome = await askRemoteDialog(
				handCall.nested,
				{ method: "confirm", args: ["Proceed?", handCall.toolCallId, {}] },
				handCall.signal,
			);
			const text = outcome.kind === "answered" ? `answered:${String(outcome.value)}` : outcome.kind;
			return { content: [{ type: "text", text }], details: {} };
		},
	});
	return { rig: opened, dialogs };
};

const text = (message: ToolResultMessage | undefined): string =>
	message?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";

/** Kills the hand while its call waits on a dialog the session holds, then restarts it on the same store and link. */
const killWhilePending =
	(placement: HandPlacement): DialogCase =>
	async (adapters) => {
		const what = `KILL-DIALOG (${placement})`;
		const { rig, dialogs } = await asking(adapters, placement);
		const outcome = rig.execute("scope", [call("c1")]);
		await rig.runUntil(() => dialogs.raised.length === 1, `${what}: the dialog reached the session`);
		rig.kill();
		await rig.restart();
		const { messages } = await rig.settle(outcome, `${what}: the session got the call's outcome`);
		await rig.advance(500);
		const [message] = messages;
		if (placement === "split-local")
			expectEqual(
				[text(message), message?.isError],
				[TOOL_RESULT_PLACEHOLDER, false],
				`${what}: today's placeholder`,
			);
		else
			expectEqual(
				message?.details,
				{ outcome: "hand_restarted", uncertain: true, hooksRan: true },
				`${what}: the call ended hand_restarted, uncertain, never rerun`,
			);
		expectEqual(dialogs.raised, ["confirm:Proceed?"], `${what}: the dialog surfaced exactly once`);
		expectEqual(dialogs.settled, ["aborted"], `${what}: the call's end settled the pending dialog`);
		expectEqual(dialogs.answer(0, true), false, `${what}: a late answer is refused`);
		expectEqual(rig.bodies, ["scope:c1"], `${what}: the tool body ran once`);
	};

/** Faults the link while a dialog is pending: it surfaces once, its answer reaches the hand, and a late answer is refused. */
const faultWhilePending: DialogCase = async (adapters) => {
	for (const profile of ["flap", "drop-reattach"] as const) {
		const what = `FAULT-DIALOG-01 (${profile})`;
		const stats: FaultStats = { refused: 0, lost: 0, reordered: 0, drops: 0 };
		const { rig, dialogs } = await asking(adapters, "cross-machine", { profile, stats });
		const outcome = rig.execute("scope", [call("c1")]);
		await rig.runUntil(() => dialogs.raised.length === 1, `${what}: the dialog reached the session`);
		// Traffic on another scope while the dialog waits: the drop-reattach profile acts on message counts.
		const noise: Array<Promise<unknown>> = [];
		for (let index = 0; stats.drops < 2 && index < 40; index++) {
			noise.push(rig.execute("other", [call(`noise${index}`)]));
			await rig.advance(30);
		}
		await rig.runUntil(() => stats.drops >= 2, `${what}: the link dropped and re-attached`);
		await rig.settle(Promise.all(noise), `${what}: the other scope's calls settled`);
		expectEqual(dialogs.answer(0, true), true, `${what}: the dialog was still pending after reconnect`);
		const { messages } = await rig.settle(outcome, `${what}: the call settled`);
		await rig.advance(2_000);
		expectEqual(text(messages[0]), "answered:true", `${what}: the answer reached the hand`);
		expectEqual(dialogs.raised, ["confirm:Proceed?"], `${what}: the dialog surfaced exactly once`);
		expectEqual(dialogs.answer(0, false), false, `${what}: a late answer is refused`);
		expectEqual(
			rig.bodies.filter((body) => body.startsWith("scope:")),
			["scope:c1"],
			`${what}: the tool body ran once`,
		);
		expectEqual(rig.faults, [], `${what}: the hand reported no fault`);
	}
};

const PLACEMENTS: readonly HandPlacement[] = ["split-local", "cross-machine"];

export interface DialogDeclaration {
	readonly id: string;
	readonly expected: string;
}

export const DIALOG_DECLARATIONS: readonly DialogDeclaration[] = [
	...PLACEMENTS.map((placement) => ({
		id: `KILL-DIALOG-01-${placement === "split-local" ? "SL" : "XM"}`,
		expected: `${placement}: the hand is killed while a remote dialog is pending; the dialog surfaced once, the call's end settles it, a late answer is refused, the body ran once`,
	})),
	{
		id: "FAULT-DIALOG-01",
		expected:
			"flap and drop-reattach profiles: a pending remote dialog surfaces once after reconnect, its answer reaches the hand, a late answer is refused",
	},
];

export const DIALOG_CASES: ReadonlyMap<string, DialogCase> = new Map<string, DialogCase>([
	...PLACEMENTS.map((placement): [string, DialogCase] => [
		`KILL-DIALOG-01-${placement === "split-local" ? "SL" : "XM"}`,
		killWhilePending(placement),
	]),
	["FAULT-DIALOG-01", faultWhilePending],
]);
