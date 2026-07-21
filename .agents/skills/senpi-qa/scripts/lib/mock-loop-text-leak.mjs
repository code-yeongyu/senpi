import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks } from "./common.mjs";

const REISSUE_GUIDANCE = "Re-issue the tool call with complete arguments.";
const XML_PATTERN = /<\/?(?:antml:)?(?:invoke|parameter)/u;
export const TEXT_LEAK_APIS = ["anthropic-messages", "openai-completions"];

export function appendTextToolLeakChecks(checks, outcome) {
	for (const check of outcome.checks) checks.ok(check.name, check.pass, check.detail);
}

export function dispatchTextToolLeakCommand(apiName, truncated, driveTurn, evidenceSlug) {
	runTextToolLeakCommand({ apiName, truncated, driveTurn, evidenceSlug })
		.then((pass) => process.exit(pass ? 0 : 1))
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
			process.exit(1);
		});
}

export async function runTextToolLeakCommand({ apiName, truncated, driveTurn, evidenceSlug }) {
	installCleanupHooks();
	const checks = createChecks(
		`mock-loop.mjs ${truncated ? "--with-truncated-text-tool-leak" : "--with-text-tool-leak"} --api ${apiName}`,
	);
	appendTextToolLeakChecks(
		checks,
		await runTextToolLeakScenario({ apiName, truncated, driveTurn, evidenceSlug }),
	);
	return checks.finish();
}

export async function runTextToolLeakScenario({ apiName, truncated, driveTurn, evidenceSlug }) {
	const guard = guardRealAuth();
	const mode = truncated ? "truncated" : "complete";
	const executionMarker = `SENPI-QA-TEXT-LEAK-EXECUTED:${apiName}:${mode}`;
	const finalMarker = `SENPI-QA-TEXT-LEAK-FINAL:${apiName}:${mode}`;
	let sentinelPath;
	const { box, server, result } = await driveTurn({
		apiName,
		turns: (sandbox) => {
			sentinelPath = join(sandbox.cwd, `text-tool-leak-${mode}.sentinel`);
			const command = truncated
				? `printf '%s\\n' '${executionMarker}' >> ${shellQuote(sentinelPath)}`
				: `printf '%s\\n' '${executionMarker}' >> ${shellQuote(sentinelPath)}; printf '%s\\n' '${executionMarker}'`;
			const close = truncated ? "" : "</invoke>";
			return [
				{
					text: `Preparing tool call.\n<invoke name="bash"><parameter name="command">${escapeXml(command)}</parameter>${close}`,
				},
				{ text: finalMarker },
			];
		},
		prompt: `Run the requested operation and finish with ${finalMarker}.`,
		extraArgs: ["--approve"],
		modelOverrides: { recoverTextToolCalls: true },
		timeoutMs: 120000,
	});

	let checks;
	let receiptDir;
	try {
		const requests = server.requests;
		const replayBody = JSON.stringify(requests[1]?.body ?? {});
		const output = `${result.stdout}\n${result.stderr}`;
		const sentinelExists = Boolean(sentinelPath && existsSync(sentinelPath));
		const executionLines = sentinelExists
			? readFileSync(sentinelPath, "utf8")
					.split(/\r?\n/u)
					.filter(Boolean)
			: [];
		const authUnchanged = guard.assertUnchanged();
		checks = [
			check(`${apiName}: ${mode} leak exits zero`, result.code === 0, `code=${result.code}`),
			check(`${apiName}: ${mode} leak performs two turns`, requests.length === 2, `requests=${requests.length}`),
			check(`${apiName}: ${mode} leak returns final text`, output.includes(finalMarker), `marker=${finalMarker}`),
			check(
				`${apiName}: ${mode} replay contains no leaked XML`,
				!XML_PATTERN.test(replayBody),
				`xmlPresent=${XML_PATTERN.test(replayBody)}`,
			),
			check(`${apiName}: ${mode} preserves real auth`, authUnchanged, guard.path),
		];

		if (truncated) {
			checks.push(
				check(`${apiName}: truncated leak never executes bash`, !sentinelExists, `sentinel=${sentinelPath}`),
				check(
					`${apiName}: truncated leak exposes re-issue guidance`,
					replayBody.includes(REISSUE_GUIDANCE),
					`guidancePresent=${replayBody.includes(REISSUE_GUIDANCE)}`,
				),
			);
		} else {
			checks.push(
				check(
					`${apiName}: complete leak executes bash exactly once`,
					executionLines.length === 1 && executionLines[0] === executionMarker,
					`executions=${executionLines.length}`,
				),
				check(
					`${apiName}: complete leak replays tool output`,
					replayBody.includes(executionMarker),
					`markerPresent=${replayBody.includes(executionMarker)}`,
				),
			);
		}

		receiptDir = evidenceDir(evidenceSlug || `mock-loop-text-leak-${apiName}-${mode}`);
		writeFileSync(
			join(receiptDir, "receipt.json"),
			`${JSON.stringify(
				{
					apiName,
					mode,
					result: { code: result.code, stdout: result.stdout, stderr: result.stderr },
					requests: requests.map((request) => ({
						method: request.method,
						path: request.url,
						hasAuthorization: Boolean(request.authorization),
						hasApiKey: Boolean(request.apiKeyHeader),
						body: request.body,
					})),
					executionLines,
					sentinelExists,
					authPath: guard.path,
					authHash: guard.before,
					checks,
				},
				null,
				2,
			)}\n`,
		);
	} finally {
		await server.stop();
		box.cleanup();
	}

	checks.push(check(`${apiName}: ${mode} sandbox cleaned`, !existsSync(box.cwd), box.cwd));
	return { apiName, truncated, checks, receiptDir };
}

function check(name, pass, detail) {
	return { name, pass, detail };
}

function escapeXml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
