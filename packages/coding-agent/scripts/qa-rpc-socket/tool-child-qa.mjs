#!/usr/bin/env bun
/**
 * Real-surface QA scenario driver for the tool-child runtime (senpi#3566).
 *
 * Usage: bun scripts/qa-rpc-socket/tool-child-qa.mjs [--runtime in-process|child] --scenario <id>
 *          [--inject A,B:v] [--env K=V ...] [--extension test/fixtures/qa-tools-extension.ts]
 *          [--expect-failure <code>] --out <dir>
 *
 * Exit codes: 0 pass (or the expected failure was observed and recorded), 1 failed assertion,
 * `record_timeout` or any other outcome, 2 usage error or unknown scenario, 3 `prerequisite_missing`
 * (the host does not advertise a capability the scenario's `requires` names). Evidence goes to
 * `<out>/<scenario>.jsonl` and `<out>/<scenario>.json`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockModel } from "./lib/mock-model.mjs";
import { injectEnv, parseQaArgs } from "./lib/qa-args.mjs";
import { createControl } from "./lib/qa-control.mjs";
import { EXIT, QaFailure } from "./lib/qa-failure.mjs";
import { MOCK_MODEL, MOCK_PROVIDER, startQaHost, writeSandboxAgentDir } from "./lib/qa-host.mjs";
import { awaitRecord, createScenarioLog } from "./lib/qa-records.mjs";
import { SCENARIOS, unmetRequirements } from "./lib/qa-scenarios.mjs";

async function defaultStartHost({ runtime, env, extension, scratch, scenario }) {
	const mock = await startMockModel(scenario.model ?? (() => ({ text: "ok" })));
	const agentDir = join(scratch, "agent");
	const workdir = join(scratch, "work");
	mkdirSync(workdir, { recursive: true });
	writeSandboxAgentDir(agentDir, { baseUrl: mock.baseUrl, workdir });
	try {
		const host = await startQaHost({ runtime, env, extension: extension && resolve(extension), scratch, agentDir });
		return { ...host, workdir, stop: async () => Promise.allSettled([host.stop(), mock.stop()]) };
	} catch (error) {
		await mock.stop();
		throw error;
	}
}

function awaitControlFile(dir, match, deadlineMs) {
	const existing = () => readdirSync(dir).find(match);
	const now = existing();
	if (now !== undefined) return Promise.resolve(now);
	return new Promise((resolvePromise, reject) => {
		const watcher = watch(dir, () => {
			const name = existing();
			if (name === undefined) return;
			clearTimeout(timer);
			watcher.close();
			resolvePromise(name);
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new QaFailure("record_timeout", `no control file in ${dir} within ${deadlineMs} ms`));
		}, deadlineMs);
		const raced = existing();
		if (raced !== undefined) {
			clearTimeout(timer);
			watcher.close();
			resolvePromise(raced);
		}
	});
}

/** The plan's cleanup rule: a killed process must be gone (not even a zombie) within 3 s. */
/**
 * Whether `pid` ended within the window, and the last `ps` state seen. A zombie (`Z`) has ended - reaping it is its
 * parent's job - so it counts as gone and is reported as `zombie: true`; any other listed state is still running.
 */
async function awaitGone(pid, windowMs = 3_000) {
	const deadline = Date.now() + windowMs;
	for (;;) {
		const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
		if (state === "") return { gone: true, zombie: false, state };
		if (state.startsWith("Z")) return { gone: true, zombie: true, state };
		if (Date.now() >= deadline) return { gone: false, zombie: false, state };
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
}

function scenarioContext(host, log, controlDir, evidenceDir) {
	const subscribe = (subscriber) => host.rpc.subscribe(subscriber);
	const durableIds = new Map();
	return {
		log,
		agentDir: host.agentDir,
		evidenceDir,
		awaitControlFile: (match, deadlineMs = 30_000) => awaitControlFile(controlDir, match, deadlineMs),
		awaitGone: (pid) => awaitGone(pid),
		// open_session does not return the durable id; the session's list_sessions row does.
		async durableSessionIdOf(sessionId) {
			const known = durableIds.get(sessionId);
			if (known !== undefined) return known;
			const listed = await host.rpc.request({ type: "list_sessions" });
			const row = (listed.data?.sessions ?? []).find((candidate) => candidate.sessionId === sessionId);
			if (typeof row?.durableSessionId !== "string") throw new QaFailure("session_unlisted", `no durable id for ${sessionId}`);
			durableIds.set(sessionId, row.durableSessionId);
			return row.durableSessionId;
		},
		protocolInfo: host.protocolInfo,
		controlDir,
		control: createControl(controlDir),
		rpc: host.rpc,
		awaitRecord: (predicate, options) => awaitRecord(subscribe, predicate, options),
		async openSession() {
			const opened = await host.rpc.request({
				type: "open_session",
				cwd: host.workdir,
				permissionPreset: "auto",
				provider: MOCK_PROVIDER,
				modelId: MOCK_MODEL,
			});
			if (opened.success !== true) throw new QaFailure("open_session_failed", JSON.stringify(opened.error ?? opened));
			const sessionId = opened.data.sessionId;
			subscribe((record) => {
				if (record.type !== "extension_ui_request" || record.method !== "select") return;
				if (Array.isArray(record.options) && record.options.includes("Allow always")) {
					host.rpc.respondUi(record.id, "Allow always", record.sessionId);
				}
			});
			log.write({ type: "session_opened", sessionId });
			return sessionId;
		},
		async prompt(sessionId, message) {
			const response = await host.rpc.request({ type: "prompt", sessionId, message });
			if (response.success !== true) throw new QaFailure("prompt_failed", JSON.stringify(response.error ?? response));
		},
	};
}

async function runScenario(scenario, host, log, controlDir, evidenceDir) {
	const unmet = unmetRequirements(scenario.requires, host.protocolInfo);
	if (unmet.length > 0 || typeof scenario.run !== "function") {
		log.write({ failure: "prerequisite_missing", unmet, implemented: typeof scenario.run === "function" });
		return { kind: "prerequisite" };
	}
	try {
		await scenario.run(scenarioContext(host, log, controlDir, evidenceDir));
		return { kind: "passed" };
	} catch (error) {
		const code = error instanceof QaFailure ? error.code : "unexpected_error";
		log.write({ failure: code, message: error instanceof Error ? error.message : String(error) });
		return { kind: "failed", code };
	}
}

function exitFor(outcome, expectFailure, log) {
	if (outcome.kind === "prerequisite") return EXIT.prerequisite;
	if (expectFailure === undefined) return outcome.kind === "passed" ? EXIT.ok : EXIT.failed;
	const observed = outcome.kind === "failed" && outcome.code === expectFailure;
	log.write(observed ? { expected_failure: expectFailure, observed: true } : { expected_failure: expectFailure, observed: false, actual: outcome.code ?? "passed" });
	const recorded = log.readAll().some((record) => record.expected_failure === expectFailure && record.observed === true);
	return observed && recorded ? EXIT.ok : EXIT.failed;
}

export async function runDriver(argv, deps = {}) {
	const parsed = parseQaArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(`tool-child-qa: ${parsed.message}\n`);
		return EXIT.usage;
	}
	const options = parsed.value;
	const scenario = (deps.registry ?? SCENARIOS).find((candidate) => candidate.id === options.scenario);
	if (scenario === undefined) {
		process.stderr.write(`tool-child-qa: unknown scenario ${options.scenario}\n`);
		return EXIT.usage;
	}
	const log = createScenarioLog(join(options.out, `${scenario.id}.jsonl`));
	const scratch = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "tcq-") : "/tmp/tcq-");
	const controlDir = join(scratch, "control");
	mkdirSync(controlDir, { recursive: true });
	// The sandbox host drops every SENPI_* variable of the driver's own environment, so the trace switch is forwarded.
	const trace = process.env.SENPI_TOOL_CHILD_TRACE === undefined ? {} : { SENPI_TOOL_CHILD_TRACE: process.env.SENPI_TOOL_CHILD_TRACE };
	const env = { ...trace, ...injectEnv(options.inject), ...options.env, SENPI_TOOL_CHILD_TEST_CONTROL_DIR: controlDir };
	log.write({ type: "start", scenario: scenario.id, runtime: options.runtime ?? "default", inject: options.inject, env: Object.keys(env) });
	let code = EXIT.failed;
	try {
		const startHost = deps.startHost ?? defaultStartHost;
		let host;
		try {
			host = await startHost({ runtime: options.runtime, env, extension: options.extension, scratch, scenario });
		} catch (error) {
			log.write({ failure: "host_start_failed", message: error instanceof Error ? error.message : String(error) });
			return EXIT.failed;
		}
		try {
			log.write({ type: "host", capabilities: host.protocolInfo.capabilities ?? [] });
			code = exitFor(await runScenario(scenario, host, log, controlDir, options.out), options.expectFailure, log);
		} finally {
			await host.stop();
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		writeFileSync(join(options.out, `${scenario.id}.json`), `${JSON.stringify({ scenario: scenario.id, exit: code, records: log.readAll() }, null, 1)}\n`);
	}
	return code;
}

if (import.meta.main) process.exit(await runDriver(process.argv.slice(2)));
