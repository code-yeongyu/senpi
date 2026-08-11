import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
} from "./common.mjs";
import { checkRealAuthUnchanged } from "./mock-loop-support.mjs";

export const KIMI_THINKING_RECOVERY_SCENARIO = "kimi-xtml-thinking-recover";

const RECOVERED_MARKER = "RECOVERED_VISIBLE_ANSWER";
const MALFORMED_THINKING =
	"Reasoning remains private. 즉 해당 키로 치는 요청은 지표 수집 대상에 정상 포함됨." +
	"<|close|><|sep|><|close|>tools<|sep|><|close|>response<|sep|><|close|>message<|sep|>";
const XTML_PATTERN = /<\|(?:close|open|sep)\|>/u;

export async function runKimiThinkingRecoveryScenario(driveTurn, evidenceSlug) {
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --scenario ${KIMI_THINKING_RECOVERY_SCENARIO}`);
	const guard = guardRealAuth();
	const { box, server, result } = await driveTurn({
		apiName: "openai-completions",
		turns: [{ reasoning: MALFORMED_THINKING, text: "\u200b" }, { text: RECOVERED_MARKER }],
		prompt: `Return ${RECOVERED_MARKER} after recovering from the malformed empty response.`,
		extraArgs: ["--model", "kimi-k3-ultrafast"],
		mockModels: [{ id: "kimi-k3-ultrafast", reasoning: true }],
		timeoutMs: 90000,
	});
	let receiptDir;
	try {
		const output = `${result.stdout}\n${result.stderr}`;
		const markerCount = output.split(RECOVERED_MARKER).length - 1;
		const firstReasoning = server.streamLog
			.filter((entry) => entry.streamId === 0 && entry.kind === "reasoning_delta")
			.map((entry) => entry.delta)
			.join("");
		const firstText = server.streamLog
			.filter((entry) => entry.streamId === 0 && entry.kind === "text_delta")
			.map((entry) => entry.delta)
			.join("");
		const replayBody = JSON.stringify(server.requests[1]?.body ?? {});
		checks.ok("real CLI exits zero after one empty-response retry", result.code === 0 && !result.timedOut, `code=${result.code}`);
		checks.ok("fake provider receives exactly two requests", server.requests.length === 2, `requests=${server.requests.length}`);
		checks.ok("malformed reasoning payload reached the real provider parser", firstReasoning === MALFORMED_THINKING, `bytes=${firstReasoning.length}`);
		checks.ok("production zero-width text block reached the real provider parser", firstText === "\u200b", `bytes=${firstText.length}`);
		checks.ok("recovered answer is visible exactly once", markerCount === 1, `markerCount=${markerCount}`);
		checks.ok("raw XTML markers never reach visible CLI output", !XTML_PATTERN.test(output), `markersVisible=${XTML_PATTERN.test(output)}`);
		checks.ok("discarded empty attempt is not replayed into request two", !replayBody.includes("<|close|>"), `markerReplayed=${replayBody.includes("<|close|>")}`);
		checkRealAuthUnchanged(checks, guard);
		receiptDir = evidenceDir(evidenceSlug || KIMI_THINKING_RECOVERY_SCENARIO);
		writeFileSync(
			join(receiptDir, "receipt.json"),
			`${JSON.stringify(
				{
					scenario: KIMI_THINKING_RECOVERY_SCENARIO,
					result: { code: result.code, stdout: result.stdout, stderr: result.stderr },
					requestCount: server.requests.length,
					markerCount,
					firstReasoning,
					firstText,
					replayedMalformedAttempt: replayBody.includes("<|close|>"),
					authPath: guard.path,
					authHash: guard.before,
				},
				null,
				2,
			)}\n`,
		);
	} finally {
		await server.stop();
		box.cleanup();
	}
	checks.ok("Kimi thinking recovery sandbox cleaned", !existsSync(box.cwd), box.cwd);
	process.exit(checks.finish() ? 0 : 1);
	return receiptDir;
}
