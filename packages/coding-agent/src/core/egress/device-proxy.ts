/**
 * `DeviceProxyEgress` (row CK9; custody design 2.3, 4.2-4.6): the device route of hosted model-key custody. For the
 * admitted loop step it applies the re-admission replay rules of 4.5 before any route or hook, writes the W4 row with
 * the admitted request before any `start`, follows the call to a durable `ended` before the terminal event, and on a
 * lost or mismatched call supersedes the row and reissues the stored request byte-for-byte under the 4.5 hook rules.
 * The placement claim is carried opaquely: the hand verifies it (`verifyPlacementClaim`, CK7/CK8) and the brain reacts to
 * the refusal codes of 4.6. Every pause is tracked local work; a user abort writes `session/step.cancelled` (W14).
 */
import type { DeviceId, EgressRouteDecision, StepRef, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type CallOutcome, followCall } from "./device-proxy-call.ts";
import type { DeviceProxyEgress, DeviceProxyEgressDeps } from "./device-proxy-ports.ts";
import {
	ABORT_TEXT,
	admittedRequestJson,
	failureMessage,
	parseStoredRequest,
	planDispatch,
	type StoredRequest,
} from "./device-proxy-request.ts";
import { nextKeyBackoffMs, stepWaits } from "./device-proxy-waits.ts";
import type { EgressCallResult, EgressCallRow } from "./ledger-schema.ts";

const isSuccess = (result: EgressCallResult | undefined): result is Extract<EgressCallResult, { kind: "message" }> =>
	result?.kind === "message" && result.events.at(-1)?.type === "done";

interface StepRun {
	readonly out: AssistantMessageEventStream;
	readonly model: Model<Api>;
	readonly options: SimpleStreamOptions | undefined;
	readonly step: StepRef;
	readonly signal: AbortSignal;
	readonly live: { row: EgressCallRow | undefined };
}

export function createDeviceProxyEgress(deps: DeviceProxyEgressDeps): DeviceProxyEgress {
	const { ledger, route, host } = deps;
	const waitsOf = (run: StepRun) => stepWaits(run.out, host, run.step, run.signal);
	const callContext = (run: StepRun, deviceId: DeviceId) => ({
		out: run.out,
		model: run.model,
		ledger,
		channel: deps.hands.channel(deviceId),
		offlineFor: deps.hands.offlineFor,
		waits: waitsOf(run),
		conditions: deps.conditions,
		clock: deps.clock,
		bounds: deps.bounds,
		signal: run.signal,
		claim: deps.claims.current,
		live: run.live,
	});

	const servedDecision = async (run: StepRun): Promise<EgressRouteDecision & { readonly deviceId: DeviceId }> => {
		for (;;) {
			const decision = route.decide(run.model.provider, await ledger.variants(run.model.provider));
			const { deviceId } = decision;
			if (decision.servedNow && decision.route === "device" && deviceId !== undefined)
				return { ...decision, deviceId };
			if (decision.servedNow) throw new Error(`the device route cannot serve a ${decision.route} decision`);
			const waitFor = decision.waitFor ?? [];
			const wait = { reason: decision.reason, steer: decision.steer ?? "", waitFor };
			await waitsOf(run).hold(wait, deps.conditions.until(waitFor, run.signal));
		}
	};

	/** 4.6: renew an expired or superseded claim, back off on an unknown registry key, and restart the same call. */
	const startWithClaim = async (
		run: StepRun,
		row: EgressCallRow,
		decision: EgressRouteDecision,
		plan: { readonly requestJson: string; readonly hooks: "enabled" | "disabled" },
	): Promise<CallOutcome> => {
		const deviceId = row.deviceId ?? "";
		const expectedSourceDigest = decision.serveOwnDefinition ? undefined : route.headDigest(row.providerId);
		const maxOutputTokens = run.options?.maxTokens;
		let backoff: number | undefined;
		for (;;) {
			const start = {
				t: "provider.call.start" as const,
				callId: row.callId,
				sessionId: deps.sessionId,
				call: row.call,
				claim: await deps.claims.current(),
				providerId: row.providerId,
				modelId: row.modelId,
				...(expectedSourceDigest === undefined ? {} : { expectedSourceDigest }),
				hooks: plan.hooks,
				...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
				request: parseStoredRequest(plan.requestJson),
				budget: {
					deadlineMs: deps.bounds.deadlineMs,
					...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
				},
			};
			const outcome = await followCall(callContext(run, deviceId), row, { start });
			if (outcome.kind !== "refused") return outcome;
			const waitFor = [{ kind: "claim-renewed" }] as const;
			const code = outcome.code;
			if (code === "registry_key_unknown") {
				backoff = nextKeyBackoffMs(backoff);
				const pause = deps.clock.sleep(backoff, run.signal);
				await waitsOf(run).hold({ reason: "claim-expired", steer: outcome.message, waitFor }, pause);
			} else {
				const steer = "renewing this session's placement claim";
				await waitsOf(run).hold({ reason: "claim-expired", steer, waitFor }, deps.claims.renew(code));
			}
		}
	};

	/** A lost (`unknown`) or mismatched call is superseded; a mismatch records the device variant in the same write. */
	const retire = async (run: StepRun, outcome: CallOutcome): Promise<EgressCallRow> => {
		const { row } = outcome;
		const deviceId = row.deviceId ?? "";
		if (outcome.kind === "unknown")
			await deps.hands
				.channel(deviceId)
				.cancel({ t: "provider.call.cancel", callId: row.callId, reason: "superseded" });
		const headDigest = route.headDigest(row.providerId);
		const variant =
			outcome.kind === "mismatch" && headDigest !== undefined
				? {
						providerId: row.providerId,
						deviceId,
						stepId: run.step.stepId,
						headDigest,
						liveAtMismatch: route.liveDigest(deviceId, row.providerId),
					}
				: undefined;
		const superseded = await ledger.supersede(row, variant);
		deps.notify({ t: "step.reset", sessionId: deps.sessionId, stepId: run.step.stepId, cause: "superseded" });
		return superseded;
	};

	const serve = async (run: StepRun, firstRequest: StoredRequest, firstPrevious: EgressCallRow | undefined) => {
		let stored = firstRequest;
		let previous = firstPrevious;
		let attempt = previous && previous.call.kind === "step" ? previous.call.attempt + 1 : run.step.attempt;
		const providerId = run.model.provider;
		for (;;) {
			if (previous?.state === "superseded" && route.capability(providerId) === "callback-stream") {
				const waitFor = [{ kind: "user-choice", choiceId: `${run.step.stepId}:${attempt}` }] as const;
				const steer = "re-run this step (tools may run again) or select another device";
				await waitsOf(run).hold(
					{ reason: "capability:callback-stream", steer, waitFor },
					deps.conditions.until(waitFor, run.signal),
				);
			}
			const decision = await servedDecision(run);
			const plan = await planDispatch(decision, stored, deps.requestHooks);
			const next = {
				callId: crypto.randomUUID(),
				sessionId: deps.sessionId,
				call: { kind: "step" as const, stepId: run.step.stepId, attempt },
				route: "device" as const,
				deviceId: decision.deviceId,
				providerId,
				modelId: run.model.id,
				epoch: run.step.fence.epoch,
				capability: route.capability(providerId),
				hooksApplied: plan.hooksApplied,
			};
			const row = await ledger.dispatch(next, plan.requestJson, previous);
			const outcome = await startWithClaim(run, row, decision, plan);
			if (outcome.kind === "ended") return;
			previous = await retire(run, outcome);
			stored = { requestJson: await ledger.readRequest(previous), hooksApplied: previous.hooksApplied };
			attempt += 1;
		}
	};

	/** The 4.5 replay rules for a step that already has a row, applied before any route decision or request hook. */
	const runStep = async (run: StepRun, context: Parameters<StreamFn>[1]): Promise<void> => {
		const { stepId } = run.step;
		if (await host.historyHasStep(stepId))
			throw new Error(`step ${stepId} is already committed; resume from history`);
		if (await ledger.isCancelled(stepId)) {
			run.out.push({ type: "error", reason: "aborted", error: failureMessage(run.model, "aborted", ABORT_TEXT) });
			return;
		}
		const latest = (await ledger.rowsForStep(stepId)).at(-1);
		if (latest?.state === "ended" && isSuccess(latest.result)) {
			for (const event of latest.result.events) run.out.push(event);
			return;
		}
		const resumable = latest?.state === "dispatched" || latest?.state === "ended" || latest?.state === "superseded";
		if (!latest || !resumable)
			return serve(run, { requestJson: admittedRequestJson(context, run.options), hooksApplied: false }, undefined);
		let previous = latest;
		if (latest.state === "dispatched") {
			const deviceId = latest.deviceId ?? "";
			if (deps.hands.offlineFor(deviceId) >= deps.bounds.resumeWindowMs) {
				const waitFor = [{ kind: "device-online", deviceId }] as const;
				const pinned = deps.conditions.until(waitFor, run.signal);
				await waitsOf(run).hold({ reason: "device-offline", steer: `open omo on ${deviceId}`, waitFor }, pinned);
			}
			const outcome = await followCall(callContext(run, deviceId), latest, { resume: true });
			if (outcome.kind === "ended") return;
			if (outcome.kind === "refused")
				throw new Error(`device ${deviceId} refused the placement claim: ${outcome.message}`);
			previous = await retire(run, outcome);
		}
		return serve(
			run,
			{ requestJson: await ledger.readRequest(previous), hooksApplied: previous.hooksApplied },
			previous,
		);
	};

	const abortFailure = async (run: StepRun): Promise<Error> => {
		const row = run.live.row;
		let cause: unknown;
		await ledger.cancelStep(run.step.stepId, row).catch((error: unknown) => {
			cause = error;
		});
		if (row?.deviceId !== undefined && row.state === "dispatched")
			await deps.hands
				.channel(row.deviceId)
				.cancel({ t: "provider.call.cancel", callId: row.callId, reason: "user" });
		return new Error(ABORT_TEXT, cause === undefined ? undefined : { cause });
	};

	return {
		stream: (model, context, options) => {
			const out = createAssistantMessageEventStream();
			const signal = options?.signal ?? new AbortController().signal;
			const run: StepRun = { out, model, options, step: host.currentStep(), signal, live: { row: undefined } };
			out.trackLocalWork(runStep(run, context)).catch(async (error: unknown) => {
				if (!signal.aborted) return out.fail(error);
				out.fail(await abortFailure(run).catch((cause: unknown) => new Error(ABORT_TEXT, { cause })));
			});
			return out;
		},
	};
}
