import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
} from "./common.mjs";
import {
	API_PRESETS,
	checkRealAuthUnchanged,
} from "./mock-loop-support.mjs";
import {
	KIMI_THINKING_RECOVERY_SCENARIO,
	runKimiThinkingRecoveryScenario,
} from "./mock-loop-kimi-thinking-recovery.mjs";
import { runAnthropicPolicyRefusalScenario } from "./mock-loop-policy-refusal.mjs";
import { HINT_429_SCENARIOS, isHint429Scenario, runHint429Scenario } from "./mock-loop-hint-429.mjs";

const OPENAI_SERVER_ERROR_MESSAGE =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID e4026cfc-c6b6-414a-8a21-c03a6adf0336 in your message.";

// Verbatim provider error captured from a real senpi session (2026-07-28,
// anthropic-api claude-fable-5): the billing class pinned-swap behavior targets.
const CREDIT_BALANCE_ERROR_MESSAGE =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdUDPLwbT8EDXCxMJBvQy"}';

const STANDARD_RETRY_SCENARIOS = {
	"billing-swap": {
		error: { status: 400, message: CREDIT_BALANCE_ERROR_MESSAGE },
		errorCount: 1,
		marker: "SENPI-QA-RETRY-BILLING-SWAP-3f0a",
		primaryAttempts: 1,
		fallbackAttempts: 1,
	},
	"transient-recover": {
		error: { status: 500, message: "overloaded_error" },
		errorCount: 2,
		marker: "SENPI-QA-RETRY-TRANSIENT-RECOVER-38cd",
		primaryAttempts: 3,
		fallbackAttempts: 0,
	},
	"model-request-rejected-recover": {
		// 400 + invalid_request_error keeps every pre-existing status/text pattern
		// from matching, so recovery can only be credited to the "model request was
		// rejected" classifier entry.
		error: {
			status: 400,
			message: "The model request was rejected. Check the request and try again.",
			type: "invalid_request_error",
		},
		errorCount: 1,
		marker: "SENPI-QA-RETRY-MODEL-REQUEST-REJECTED-7d21",
		primaryAttempts: 2,
		fallbackAttempts: 0,
	},
	"budget-exhaust": {
		error: { status: 500, message: "overloaded_error" },
		errorCount: 4,
		marker: "SENPI-QA-RETRY-BUDGET-EXHAUST-7a16",
		primaryAttempts: 4,
		fallbackAttempts: 1,
	},
	"server-error-fallback": {
		apiName: "openai-responses",
		error: { status: 500, message: OPENAI_SERVER_ERROR_MESSAGE },
		errorCount: 4,
		marker: "SENPI-QA-RETRY-SERVER-ERROR-FALLBACK-e402",
		primaryAttempts: 4,
		fallbackAttempts: 1,
	},
	"long-retry-after": {
		error: { status: 429, message: "HTTP 429: rate_limit_exceeded - retry after 3600 seconds" },
		errorCount: 1,
		marker: "SENPI-QA-RETRY-LONG-RETRY-AFTER-b4e1",
		primaryAttempts: 1,
		fallbackAttempts: 1,
	},
};

const POLICY_REFUSAL_SCENARIO = "anthropic-policy-refusal-fallback";

export function retryScenarioNames() {
	return [
		...Object.keys(STANDARD_RETRY_SCENARIOS),
		POLICY_REFUSAL_SCENARIO,
		KIMI_THINKING_RECOVERY_SCENARIO,
		...HINT_429_SCENARIOS,
	];
}

export function isRetryScenario(name) {
	return retryScenarioNames().includes(name);
}

export async function checkStandardRetryScenarios(checks, driveTurn) {
	for (const scenarioName of Object.keys(STANDARD_RETRY_SCENARIOS)) {
		const scenario = STANDARD_RETRY_SCENARIOS[scenarioName];
		await checkStandardRetryScenario(checks, scenarioName, scenario.apiName ?? "openai-completions", driveTurn);
	}
}

export async function runRetryScenario(scenarioName, apiName, driveTurn, evidenceSlug) {
	if (isHint429Scenario(scenarioName)) {
		await runHint429Scenario({ scenarioName, apiName, evidenceSlug });
		return;
	}
	if (scenarioName === KIMI_THINKING_RECOVERY_SCENARIO) {
		if (apiName !== "openai-completions") {
			throw new Error(`${KIMI_THINKING_RECOVERY_SCENARIO} requires --api openai-completions`);
		}
		await runKimiThinkingRecoveryScenario(driveTurn, evidenceSlug);
		return;
	}
	if (scenarioName === POLICY_REFUSAL_SCENARIO) {
		if (apiName !== "anthropic-messages") {
			throw new Error(`${POLICY_REFUSAL_SCENARIO} requires --api anthropic-messages`);
		}
		await runAnthropicPolicyRefusalScenario(evidenceSlug);
		return;
	}
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --scenario ${scenarioName}`);
	const guard = guardRealAuth();
	await checkStandardRetryScenario(checks, scenarioName, apiName, driveTurn, evidenceSlug);
	checkRealAuthUnchanged(checks, guard);
	process.exit(checks.finish() ? 0 : 1);
}

async function checkStandardRetryScenario(checks, scenarioName, apiName, driveTurn, evidenceSlug) {
	const scenario = STANDARD_RETRY_SCENARIOS[scenarioName];
	if (!scenario) throw new Error(`unknown retry scenario ${scenarioName}`);
	const preset = API_PRESETS[apiName];
	const fallbackModelId = `${preset.modelId}-fallback`;
	const expectedModels = [
		...Array(scenario.primaryAttempts).fill(preset.modelId),
		...Array(scenario.fallbackAttempts).fill(fallbackModelId),
	];
	const { box, server, result } = await driveTurn({
		apiName,
		turns: [...Array(scenario.errorCount).fill({ error: scenario.error }), { text: scenario.marker }],
		prompt: `Return ${scenario.marker} after recovering from the scripted provider error.`,
		mockModels: [{ id: fallbackModelId }],
		retry: {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 0,
			provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
			fallbackChains: { [`${preset.provider}/${preset.modelId}`]: [`${preset.provider}/${fallbackModelId}`] },
		},
		timeoutMs: 60000,
	});
	try {
		const requests = server.requests.filter((request) => request.url?.includes(preset.path));
		const modelSequence = requests.map((request) => request.model);
		const counts = new Map();
		for (const modelId of modelSequence) counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
		const transcript = [
			`scenario=${scenarioName}`,
			`attempts=${modelSequence.length}`,
			`sequence=${modelSequence.map((modelId, index) => `${index + 1}:${preset.provider}/${modelId}`).join(",") || "none"}`,
			`modelAttempts=${[preset.modelId, fallbackModelId].map((modelId) => `${preset.provider}/${modelId}:${counts.get(modelId) ?? 0}`).join(",")}`,
			`switched=${modelSequence.includes(fallbackModelId) ? "yes" : "no"}`,
		];
		process.stdout.write(`SENPI_QA_RETRY_TRANSCRIPT ${transcript.join(" ")}\n`);
		const markerReturned = `${result.stdout}${result.stderr}`.includes(scenario.marker);
		const attemptsMatch = JSON.stringify(modelSequence) === JSON.stringify(expectedModels);
		const pass = result.code === 0 && !result.timedOut && markerReturned && attemptsMatch;
		if (evidenceSlug) {
			const dir = evidenceDir(evidenceSlug);
			writeFileSync(
				join(dir, "retry-transcript.json"),
				`${JSON.stringify(
					{
						scenario: scenarioName,
						api: apiName,
						attempts: modelSequence.length,
						sequence: modelSequence.map((modelId) => `${preset.provider}/${modelId}`),
						modelAttempts: Object.fromEntries(counts),
						switched: modelSequence.includes(fallbackModelId),
						markerReturned,
						exitCode: result.code,
					},
					null,
					2,
				)}\n`,
			);
		}
		checks.ok(
			`${scenarioName}: scripted provider errors follow the expected retry/fallback path`,
			pass,
			`code=${result.code} marker=${markerReturned} expected=${expectedModels.join(" -> ")} actual=${modelSequence.join(" -> ") || "none"}`,
		);
		if (!pass) process.stderr.write(`\n--- ${scenarioName} stderr tail ---\n${result.stderr.slice(-1500)}\n`);
		return pass;
	} finally {
		await server.stop();
		box.cleanup();
	}
}
