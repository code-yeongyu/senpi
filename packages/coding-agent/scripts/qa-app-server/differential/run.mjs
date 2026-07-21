#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeModelServer } from "../../../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";
import * as approvals from "../../../test/qa/app-server/differential/approvals.mjs";
import * as catalogs from "../../../test/qa/app-server/differential/catalogs.mjs";
import * as compaction from "../../../test/qa/app-server/differential/compaction.mjs";
import * as errors from "../../../test/qa/app-server/differential/errors.mjs";
import * as fuzzy from "../../../test/qa/app-server/differential/fuzzy.mjs";
import * as gaps from "../../../test/qa/app-server/differential/gaps.mjs";
import { runHandshake } from "../../../test/qa/app-server/differential/handshake.mjs";
import * as lifecycle from "../../../test/qa/app-server/differential/lifecycle.mjs";
import * as pagination from "../../../test/qa/app-server/differential/pagination.mjs";
import * as search from "../../../test/qa/app-server/differential/search.mjs";
import * as turns from "../../../test/qa/app-server/differential/turns.mjs";
import {
	assertNoStructuralDifferences,
	compareAllowlistedCapabilityDelta,
	compareStructuralTranscripts,
} from "./compare.mjs";
import {
	CODEX_PORT,
	codexLaunch,
	createCell,
	FAKE_MODEL_PORT,
	SENPI_PORT,
	senpiLaunch,
} from "./cell.mjs";
import { assertClassifiedDiff, diffTranscripts, parseAllowlist } from "./diff.mjs";
import { normalizeTranscript } from "./normalize.mjs";
import { ORACLE_BINARY } from "./build-oracle.mjs";
import { ReadinessError, waitForHttpReady } from "./readiness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "..", "..");
const repoRoot = resolve(packageDir, "..", "..");
const evidenceDir = join(repoRoot, "local-ignore", "qa-evidence", "20260719-app-server-parity-task25");
const manifestPath = join(packageDir, "test", "qa", "app-server", "capability-manifest.json");
const gapsPath = join(packageDir, "test", "qa", "app-server", "differential", "expected-gaps.json");
const allowlistPath = join(here, "allowlist.json");
const qaPorts = [FAKE_MODEL_PORT, CODEX_PORT, SENPI_PORT];

const handshake = Object.freeze({
	name: "handshake",
	expectation: "exactParity",
	methods: Object.freeze(["initialize"]),
	minModelRequests: 0,
	run: (endpoints) => runHandshake(endpoints),
});
const scenarios = Object.freeze([
	handshake,
	Object.freeze({ ...lifecycle }),
	Object.freeze({ ...turns }),
	Object.freeze({ ...approvals }),
	Object.freeze({ ...search }),
	Object.freeze({ ...pagination }),
	Object.freeze({ ...compaction }),
	Object.freeze({ ...errors }),
	Object.freeze({ ...catalogs }),
	Object.freeze({ ...fuzzy }),
	Object.freeze({ ...gaps }),
]);

class DifferentialHarnessError extends Error {
	name = "DifferentialHarnessError";
}

export async function runDifferential({ scenario, all = false } = {}) {
	accessSync(ORACLE_BINARY, constants.X_OK);
	mkdirSync(evidenceDir, { recursive: true });
	const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
	const gaps = parseExpectedGaps(JSON.parse(readFileSync(gapsPath, "utf8")), manifest);
	const selected = selectScenarios({ scenario, all });
	validateScenarioCoverage(selected, manifest);
	const totals = { pass: 0, unclassified: 0, regressions: 0 };
	for (const current of selected) {
		const result = await runScenario(current, gaps);
		totals.pass += result.pass ? 1 : 0;
		totals.unclassified += result.unclassified;
		totals.regressions += result.regressions;
	}
	process.stdout.write(
		`SCENARIOS_PASS=${totals.pass}/${selected.length} UNCLASSIFIED=${totals.unclassified} REGRESSIONS=${totals.regressions}\n`,
	);
	if (totals.pass !== selected.length || totals.unclassified !== 0 || totals.regressions !== 0) {
		throw new DifferentialHarnessError("Differential scenario matrix did not reach its parity gate.");
	}
}

async function runScenario(scenario, gaps) {
	const resources = { cell: undefined, fake: undefined, servers: [] };
	let failure;
	let comparison = { differences: [], unclassified: [] };
	const cleanup = makeCleanup(resources);
	const signalHandler = async () => {
		try {
			await cleanup();
		} finally {
			process.exit(130);
		}
	};
	process.once("SIGINT", signalHandler);
	process.once("SIGTERM", signalHandler);
	try {
		resources.cell = createCell({
			codexApprovalPolicy: scenario.codexApprovalPolicy,
			senpiPermissionPreset: scenario.senpiPermissionPreset,
		});
		resources.fake = await startFakeModelServer({
			port: FAKE_MODEL_PORT,
			turns: scenario.modelTurns ?? [{ text: "unused" }],
		});
		if (resources.fake.port !== FAKE_MODEL_PORT) {
			throw new DifferentialHarnessError("Fake model server bound an unexpected port.");
		}
		resources.servers = [codexLaunch(resources.cell), senpiLaunch(resources.cell)].map(spawnServer);
		await Promise.all([
			waitForReady(resources.servers[0], CODEX_PORT),
			waitForReady(resources.servers[1], SENPI_PORT),
		]);
		const endpoints = [
			{ target: "codex", url: `ws://127.0.0.1:${CODEX_PORT}`, token: resources.cell.token, port: CODEX_PORT },
			{ target: "senpi", url: `ws://127.0.0.1:${SENPI_PORT}`, token: resources.cell.token, port: SENPI_PORT },
		];
		const results = await scenario.run(endpoints, { cell: resources.cell });
		assertOfflineFixture({ scenario, fake: resources.fake, cell: resources.cell });
		const [oracleResult, candidateResult] = results;
		if (!oracleResult || !candidateResult) throw new DifferentialHarnessError(`${scenario.name} did not return both targets.`);
		const oracle = normalizeTranscript(oracleResult.transcript, {
			tempPaths: [resources.cell.codexHome, resources.cell.dir],
			tokens: [resources.cell.token],
		});
		const candidate = normalizeTranscript(candidateResult.transcript, {
			tempPaths: [resources.cell.senpiAgentDir, resources.cell.dir],
			tokens: [resources.cell.token],
		});
		const comparisonOracle =
			scenario.project === undefined
				? oracle
				: normalizeTranscript(scenario.project(oracleResult.transcript), {
					tempPaths: [resources.cell.codexHome, resources.cell.dir],
					tokens: [resources.cell.token],
				});
		const comparisonCandidate =
			scenario.project === undefined
				? candidate
				: normalizeTranscript(scenario.project(candidateResult.transcript), {
					tempPaths: [resources.cell.senpiAgentDir, resources.cell.dir],
					tokens: [resources.cell.token],
				});
		writeJsonl(join(evidenceDir, `${scenario.name}-codex.normalized.jsonl`), oracle);
		writeJsonl(join(evidenceDir, `${scenario.name}-senpi.normalized.jsonl`), candidate);
		if (scenario.project !== undefined) {
			writeJsonl(join(evidenceDir, `${scenario.name}-codex.comparison.jsonl`), comparisonOracle);
			writeJsonl(join(evidenceDir, `${scenario.name}-senpi.comparison.jsonl`), comparisonCandidate);
		}
		comparison = compareScenario({ scenario, oracle: comparisonOracle, candidate: comparisonCandidate, gaps });
		writeFileSync(join(evidenceDir, `${scenario.name}-diff.json`), `${JSON.stringify(comparison, null, 2)}\n`);
		for (const difference of comparison.differences) {
			process.stdout.write(
				`DIFF=${difference.classification ?? "unclassified"} SCENARIO=${scenario.name} RULE=${difference.ruleId ?? "automatic"} PATH=${difference.path}\n`,
			);
		}
		const unclassified = comparison.unclassified.length;
		const regressions = comparison.differences.filter(
			(difference) => difference.classification === "parity-regression" || difference.classification === "harness-defect",
		).length;
		if (unclassified !== 0 || regressions !== 0) {
			throw new DifferentialHarnessError(
				`${scenario.name} has UNCLASSIFIED=${unclassified} REGRESSIONS=${regressions}.`,
			);
		}
		process.stdout.write(
			`OFFLINE_MODEL_REQUESTS=${resources.fake.requests.length} MODEL_ORIGIN=127.0.0.1:${FAKE_MODEL_PORT}\n`,
		);
		process.stdout.write(
			`SCENARIO=${scenario.name} EXPECTATION=${scenario.expectation} RESULT=pass UNCLASSIFIED=0 REGRESSIONS=0\n`,
		);
	} catch (error) {
		failure = error;
	} finally {
		process.removeListener("SIGINT", signalHandler);
		process.removeListener("SIGTERM", signalHandler);
		try {
			await cleanup();
		} catch (error) {
			failure ??= error;
		}
		try {
			assertPortsEmpty();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
	return { pass: true, unclassified: comparison.unclassified.length, regressions: 0 };
}

function compareScenario({ scenario, oracle, candidate, gaps }) {
	switch (scenario.expectation) {
		case "exactParity": {
			const allowlist = parseAllowlist(JSON.parse(readFileSync(allowlistPath, "utf8")));
			const result = diffTranscripts({ scenario: scenario.name, oracle, candidate, allowlist });
			assertClassifiedDiff(result);
			return result;
		}
		case "structuralParity": {
			const result = compareStructuralTranscripts({ oracle, candidate });
			assertNoStructuralDifferences(result);
			return result;
		}
		case "allowlistedCapabilityDelta": {
			const result = compareAllowlistedCapabilityDelta({
				oracle,
				candidate,
				gapForMethod: (method) => gaps.byMethod.get(method),
			});
			assertNoUnclassified(result);
			return result;
		}
		default:
			throw new DifferentialHarnessError(`Unknown differential expectation: ${scenario.expectation}`);
	}
}

function selectScenarios({ scenario, all }) {
	if (all) {
		if (scenario !== undefined) throw new DifferentialHarnessError("Use --all or --scenario, not both.");
		return scenarios;
	}
	const requested = scenario ?? "handshake";
	const selected = scenarios.find((entry) => entry.name === requested);
	if (!selected) throw new DifferentialHarnessError(`Unknown differential scenario: ${requested}`);
	return [selected];
}

function parseManifest(value) {
	if (!isObject(value) || !isObject(value.implemented) || !isObject(value.differentialExpectation)) {
		throw new DifferentialHarnessError("Capability manifest is missing differentialExpectation.");
	}
	const implemented = [...arrayOfStrings(value.implemented.stable), ...arrayOfStrings(value.implemented.experimental)];
	const expectations = new Map(Object.entries(value.differentialExpectation));
	const supported = new Set(["exactParity", "structuralParity", "allowlistedCapabilityDelta"]);
	if (new Set(implemented).size !== implemented.length) throw new DifferentialHarnessError("Capability manifest duplicates an implemented method.");
	for (const method of implemented) {
		const expectation = expectations.get(method);
		if (!supported.has(expectation)) {
			throw new DifferentialHarnessError(`${method} lacks a valid differentialExpectation.`);
		}
	}
	if (expectations.size !== implemented.length) {
		throw new DifferentialHarnessError("differentialExpectation must contain exactly the implemented methods.");
	}
	return {
		implemented: new Set(implemented),
		expectations,
		notificationExpectations: isObject(value.differentialNotificationExpectation)
			? new Map(Object.entries(value.differentialNotificationExpectation))
			: new Map(),
	};
}

function parseExpectedGaps(value, manifest) {
	if (!isObject(value) || !Array.isArray(value.gaps)) {
		throw new DifferentialHarnessError("expected-gaps.json must contain a gaps array.");
	}
	const byMethod = new Map();
	for (const gap of value.gaps) {
		if (!isObject(gap) || typeof gap.id !== "string" || gap.id.length === 0 || typeof gap.rationale !== "string" || gap.rationale.trim().length === 0) {
			throw new DifferentialHarnessError("Each expected gap requires an id and rationale.");
		}
		for (const method of arrayOfStrings(gap.methods)) {
			const expectation = manifest.expectations.get(method) ?? manifest.notificationExpectations.get(method);
			if (expectation !== "allowlistedCapabilityDelta") {
				throw new DifferentialHarnessError(`Expected gap ${gap.id} does not map ${method} to allowlistedCapabilityDelta.`);
			}
			if (byMethod.has(method)) throw new DifferentialHarnessError(`Expected gap method is duplicated: ${method}`);
			byMethod.set(method, Object.freeze({ id: gap.id, rationale: gap.rationale.trim() }));
		}
	}
	return { byMethod };
}

function validateScenarioCoverage(selected, manifest) {
	const covered = new Map();
	for (const scenario of selected) {
		for (const method of scenario.methods) {
			if (!manifest.implemented.has(method)) {
				throw new DifferentialHarnessError(`${scenario.name} references non-implemented method ${method}.`);
			}
			if (manifest.expectations.get(method) !== scenario.expectation) {
				throw new DifferentialHarnessError(
					`${scenario.name} runs ${method} under ${scenario.expectation}, not ${manifest.expectations.get(method)}.`,
				);
			}
			covered.set(method, scenario.name);
		}
	}
	if (selected.length !== scenarios.length) return;
	for (const method of manifest.implemented) {
		if (!covered.has(method)) throw new DifferentialHarnessError(`No differential scenario covers ${method}.`);
	}
}

function assertOfflineFixture({ scenario, fake, cell }) {
	const expectedOrigin = `http://127.0.0.1:${FAKE_MODEL_PORT}/v1`;
	const config = readFileSync(join(cell.codexHome, "config.toml"), "utf8");
	const models = readFileSync(join(cell.senpiAgentDir, "models.json"), "utf8");
	if (!config.includes(expectedOrigin) || !models.includes(expectedOrigin)) {
		throw new DifferentialHarnessError("A differential model fixture does not point at 127.0.0.1:18990.");
	}
	if (fake.origin !== `http://127.0.0.1:${FAKE_MODEL_PORT}`) {
		throw new DifferentialHarnessError("Fake model origin is not the required loopback endpoint.");
	}
	const minimum = scenario.minModelRequests ?? 0;
	if (fake.requests.length < minimum) {
		throw new DifferentialHarnessError(`${scenario.name} made ${fake.requests.length} model requests; expected at least ${minimum}.`);
	}
	for (const request of fake.requests) {
		if (typeof request.url !== "string" || !request.url.startsWith("/v1/")) {
			throw new DifferentialHarnessError("Observed a model request outside the loopback /v1 fixture boundary.");
		}
	}
}

function assertNoUnclassified(result) {
	if (result.unclassified.length === 0) return;
	const summary = result.unclassified.map((entry) => `${entry.index}:${entry.path}`).join(", ");
	throw new DifferentialHarnessError(`Unclassified allowlisted capability delta: ${summary}`);
}

function spawnServer(spec) {
	const child = spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		detached: process.platform !== "win32",
		env: spec.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (chunk) => {
		output = `${output}${chunk.toString("utf8")}`.slice(-12000);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const closed = new Promise((resolveClosed) => {
		child.once("error", (error) => resolveClosed({ error }));
		child.once("close", (code, signal) => resolveClosed({ code, signal }));
	});
	return { ...spec, child, closed, output: () => output };
}

async function waitForReady(server, port, timeoutMs = 30000) {
	try {
		await waitForHttpReady({ server, port, deadlineMs: timeoutMs });
	} catch (error) {
		if (!(error instanceof ReadinessError)) throw error;
		throw new DifferentialHarnessError(`${error.message}\n${sanitize(server.output())}`, { cause: error });
	}
}

function makeCleanup(resources) {
	let cleanupPromise;
	return () => {
		cleanupPromise ??= (async () => {
			const failures = [];
			const serverResults = await Promise.allSettled(resources.servers.map(stopServer));
			for (const result of serverResults) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			try {
				await resources.fake?.stop();
				await awaitPortFree(FAKE_MODEL_PORT, 15000);
			} catch (error) {
				failures.push(error);
			}
			try {
				resources.cell?.cleanup();
			} catch (error) {
				failures.push(error);
			}
			const cellRemains = resources.cell !== undefined && existsSync(resources.cell.dir);
			if (cellRemains) failures.push(new DifferentialHarnessError("Differential cell was not removed."));
			process.stdout.write(`CELL_CLEANUP=${cellRemains ? "present" : "removed"}\n`);
			if (failures.length > 0) throw failures[0];
		})();
		return cleanupPromise;
	};
}

async function stopServer(server) {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return;
	signalChild(server.child, "SIGTERM");
	if (await closesWithin(server.closed, 2500)) return;
	signalChild(server.child, "SIGKILL");
	if (!(await closesWithin(server.closed, 5000))) {
		throw new DifferentialHarnessError(`${server.label} did not exit during cleanup.`);
	}
}

function signalChild(child, signal) {
	if (child.pid === undefined) return;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
	}
}

function closesWithin(closed, timeoutMs) {
	return new Promise((resolveClosed) => {
		const timer = setTimeout(() => resolveClosed(false), timeoutMs);
		closed.then(() => {
			clearTimeout(timer);
			resolveClosed(true);
		});
	});
}

async function awaitPortFree(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	const pollIntervalMs = 100;
	while (Date.now() < deadline) {
		const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
		const empty = result.status === 1 && result.stdout.length === 0;
		if (empty) return;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new DifferentialHarnessError(`Port ${port} did not become free within ${timeoutMs}ms after fake model server stop.`);
}

function assertPortsEmpty() {
	for (const port of qaPorts) {
		const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
		const empty = result.status === 1 && result.stdout.length === 0;
		process.stdout.write(`LSOF_PORT_${port}=${empty ? "empty" : "occupied"}\n`);
		if (!empty) throw new DifferentialHarnessError(`QA port ${port} still has a listener after cleanup.`);
	}
}

function writeJsonl(path, records) {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function arrayOfStrings(value) {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new DifferentialHarnessError("Expected a string array in differential metadata.");
	}
	return value;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitize(value) {
	return value.replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>").slice(-4000);
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		await runDifferential({ scenario: flag("--scenario"), all: process.argv.includes("--all") });
	} catch (error) {
		process.stderr.write(`${sanitize(errorMessage(error))}\n`);
		process.exitCode = 1;
	}
}

function errorMessage(error) {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause;
	return cause instanceof Error ? `${error.message}\nCaused by: ${errorMessage(cause)}` : error.message;
}
