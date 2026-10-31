import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { CONTINUATION_HOLD_STATE_EVENT, WAKE_SOURCE_STATE_EVENT } from "../monitor-state-event.ts";
import { detectLoop, NoticeGate } from "./detectors.ts";
import { IdenticalLoopEscalation } from "./escalation.ts";
import { FailedRepeatTracker } from "./failure-repeats.ts";
import {
	buildLoopGuardBlockReason,
	buildLoopGuardFailedRepeatReminder,
	buildLoopGuardFailedRepeatSteer,
	buildLoopGuardFailedRepeatWarning,
	buildLoopGuardHardStopSteer,
	buildLoopGuardHardStopWarning,
	buildLoopGuardReminder,
	LOOP_GUARD_ESCALATION_CUSTOM_TYPE,
	LOOP_GUARD_NOTICE_CUSTOM_TYPE,
	LOOP_GUARD_RECOVERY_CUSTOM_TYPE,
	type LoopGuardEscalationDetails,
	type LoopGuardStopReason,
} from "./notice.ts";
import { renderLoopGuardEscalation, renderLoopGuardNotice } from "./renderer.ts";
import { ToolCallTracker } from "./tracker.ts";

const LOOP_GUARD_HARD_STOP_WAKE_SOURCE = "loop-guard-hard-stop";

export default function loopGuardExtension(pi: ExtensionAPI): void {
	const tracker = new ToolCallTracker();
	const gate = new NoticeGate();
	const escalation = new IdenticalLoopEscalation();
	const failedRepeats = new FailedRepeatTracker();
	let pendingRecovery: { readonly reason: LoopGuardStopReason; readonly toolName: string } | undefined;
	let recoveryWakeSourceActive = false;
	let continuationHoldActive = false;

	const setRecoveryWakeSourceActive = (active: boolean): void => {
		if (recoveryWakeSourceActive === active) return;
		recoveryWakeSourceActive = active;
		pi.events?.emit(WAKE_SOURCE_STATE_EVENT, {
			source: LOOP_GUARD_HARD_STOP_WAKE_SOURCE,
			activeCount: active ? 1 : 0,
		});
	};

	const setContinuationHoldActive = (active: boolean): void => {
		if (continuationHoldActive === active) return;
		continuationHoldActive = active;
		pi.events?.emit(CONTINUATION_HOLD_STATE_EVENT, {
			source: LOOP_GUARD_HARD_STOP_WAKE_SOURCE,
			active,
		});
	};

	const reset = (): void => {
		tracker.reset();
		gate.reset();
		escalation.reset();
		failedRepeats.reset();
		pendingRecovery = undefined;
		setRecoveryWakeSourceActive(false);
		setContinuationHoldActive(false);
	};

	const interruptTurn = (
		ctx: ExtensionContext,
		details: LoopGuardEscalationDetails,
		warning: string,
		announce: boolean,
	): void => {
		setRecoveryWakeSourceActive(true);
		if (!announce) setContinuationHoldActive(true);
		if (announce) {
			pi.sendMessage(
				{ customType: LOOP_GUARD_ESCALATION_CUSTOM_TYPE, content: warning, display: true, details },
				{ triggerTurn: false, deliverAs: "steer" },
			);
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			pendingRecovery = { reason: details.reason, toolName: details.toolName };
		}
		ctx.abort("system");
	};

	pi.registerMessageRenderer(LOOP_GUARD_NOTICE_CUSTOM_TYPE, renderLoopGuardNotice);
	pi.registerMessageRenderer(LOOP_GUARD_ESCALATION_CUSTOM_TYPE, renderLoopGuardEscalation);

	pi.on("session_start", () => reset());
	pi.on("session_shutdown", () => reset());

	pi.on("input", (event) => {
		if (event.source !== "extension") reset();
	});

	pi.on("tool_execution_start", (event) => {
		const record = tracker.record(event.toolName, event.args);
		failedRepeats.observeStart(event.toolCallId, record);
		const patternChanged = escalation.observeAttempt(event.toolCallId, record);
		if (patternChanged) {
			pendingRecovery = undefined;
			setRecoveryWakeSourceActive(false);
			setContinuationHoldActive(false);
		}
		const detection = detectLoop(tracker.records, gate);
		if (detection === undefined) return;
		escalation.observeNotice(detection);
		pi.sendMessage(
			{
				customType: LOOP_GUARD_NOTICE_CUSTOM_TYPE,
				content: buildLoopGuardReminder(detection),
				display: true,
				details: detection,
			},
			{ triggerTurn: false, deliverAs: "steer" },
		);
	});

	pi.on("turn_end", () => {
		escalation.finishTurn();
		failedRepeats.finishTurn();
	});

	// A call that fails argument validation ends before the tool_call hook, so repeated failures are counted here.
	pi.on("tool_execution_end", (event, ctx) => {
		const decision = failedRepeats.observeEnd(event.toolCallId, event.isError);
		switch (decision.kind) {
			case "none":
				return;
			case "warn":
				pi.sendMessage(
					{
						customType: LOOP_GUARD_NOTICE_CUSTOM_TYPE,
						content: buildLoopGuardFailedRepeatReminder(decision.detection),
						display: true,
						details: decision.detection,
					},
					{ triggerTurn: false, deliverAs: "steer" },
				);
				return;
			case "stop":
				interruptTurn(
					ctx,
					{ reason: "failed-repeats", toolName: decision.toolName, failedCallCount: decision.failedCallCount },
					buildLoopGuardFailedRepeatWarning(decision.toolName, decision.failedCallCount),
					decision.announce,
				);
				return;
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const decision = escalation.consumeToolCall(event.toolCallId);
		switch (decision.kind) {
			case "allow":
				return undefined;
			case "block":
				return {
					block: true,
					reason: buildLoopGuardBlockReason(decision.toolName, decision.blockedCallCount),
					terminate: false,
				};
			case "hardStop": {
				interruptTurn(
					ctx,
					{ reason: "blocked-repeats", toolName: decision.toolName, blockedCallCount: decision.blockedCallCount },
					buildLoopGuardHardStopWarning(decision.toolName, decision.blockedCallCount),
					decision.announce,
				);
				return {
					block: true,
					reason: buildLoopGuardBlockReason(decision.toolName, decision.blockedCallCount),
					terminate: false,
				};
			}
		}
	});

	pi.on("agent_start", () => {
		setRecoveryWakeSourceActive(false);
		setContinuationHoldActive(false);
	});

	pi.on("agent_settled", () => {
		const recovery = pendingRecovery;
		if (recovery === undefined) return;
		pendingRecovery = undefined;
		pi.sendMessage(
			{
				customType: LOOP_GUARD_RECOVERY_CUSTOM_TYPE,
				content:
					recovery.reason === "failed-repeats"
						? buildLoopGuardFailedRepeatSteer(recovery.toolName)
						: buildLoopGuardHardStopSteer(recovery.toolName),
				display: false,
			},
			{ triggerTurn: true },
		);
	});
}
