import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import serviceTierExtension from "../../src/core/extensions/builtin/service-tier.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Manual-QA channel (task 10): drives the REAL `/fast` handler against a REAL temp agent dir with
 * a codex-shaped model, then constructs a FRESH session (a second harness over the SAME dir), and
 * asserts the binary PASS/FAIL observable from the user's complaint: fast mode is still ON after
 * the restart, settings.json shows modelServiceTiers[baseKey]="priority"; then `/fast off`, restart
 * again, OFF with value "auto" (not a deleted key). models.json `api` is a free-form string, so the
 * sandbox provider declaring `api: "openai-codex-responses"` satisfies the handler with no network.
 *
 * Evidence is streamed to local-ignore/qa-evidence/<date>-fast-reasoning-effort/task-10-manual-qa.txt.
 */

// this file lives at <repo>/packages/coding-agent/test/suite/fast-mode-manual-qa.test.ts
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
const EVIDENCE_FILE = join(
	REPO_ROOT,
	"local-ignore",
	"qa-evidence",
	"20260816-fast-reasoning-effort",
	"task-10-manual-qa.txt",
);

const lines: string[] = [];
function out(s: string): void {
	lines.push(s);
}

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const BASE_MODEL_ID = "gpt-5.6-sol";
const BASE_KEY = `${CODEX_PROVIDER}/${BASE_MODEL_ID}`;

describe("/fast manual QA — real handler, fresh session over the same agent dir", () => {
	const harnesses: Harness[] = [];

	function settingsFileOf(h: Harness): string {
		return join(h.tempDir, "agent", "settings.json");
	}
	function readBytes(h: Harness): Record<string, unknown> {
		return JSON.parse(readFileSync(settingsFileOf(h), "utf-8")) as Record<string, unknown>;
	}

	async function freshDir(options: { seedMemory?: Record<string, unknown> } = {}): Promise<Harness> {
		const h = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }],
			fileSettings: true,
			settings: options.seedMemory ?? {},
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(h);
		await h.session.bindExtensions({});
		return h;
	}

	/** A genuinely fresh session over the SAME agent dir: a new harness seeded from the persisted settings. */
	async function restart(prev: Harness): Promise<Harness> {
		const h = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }],
			fileSettings: true,
			settings: readBytes(prev) as never,
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(h);
		await h.session.bindExtensions({});
		return h;
	}

	it("PASS: /fast on sticks across restart; /fast off becomes explicit auto", async () => {
		// --- session 1: /fast on -------------------------------------------------
		const s1 = await freshDir();
		await s1.session.prompt("/fast on");
		const p1 = {
			input: "/fast on",
			isFastActive: s1.session.isFastModeActive(),
			settingsBytes: JSON.stringify(readBytes(s1).modelServiceTiers),
		};
		out(`[session1] ${JSON.stringify(p1)}`);

		// --- session 2: FRESH over the same dir ----------------------------------
		const s2 = await restart(s1);
		const p2 = {
			freshSession: true,
			isFastActive: s2.session.isFastModeActive(),
			settingsBytes: JSON.stringify(readBytes(s2).modelServiceTiers),
		};
		out(`[session2 fresh] ${JSON.stringify(p2)}`);

		const binPass1 =
			s2.session.isFastModeActive() === true && readBytes(s2).modelServiceTiers?.[BASE_KEY as never] === "priority";

		// --- session 2: /fast off ------------------------------------------------
		await s2.session.prompt("/fast off");
		const p3 = {
			input: "/fast off",
			isFastActive: s2.session.isFastModeActive(),
			settingsBytes: JSON.stringify(readBytes(s2).modelServiceTiers),
		};
		out(`[session2 off] ${JSON.stringify(p3)}`);

		// --- session 3: FRESH over the same dir ----------------------------------
		const s3 = await restart(s2);
		const p4 = {
			freshSession: true,
			isFastActive: s3.session.isFastModeActive(),
			settingsBytes: JSON.stringify(readBytes(s3).modelServiceTiers),
		};
		out(`[session3 fresh] ${JSON.stringify(p4)}`);

		const binPass2 =
			s3.session.isFastModeActive() === false && readBytes(s3).modelServiceTiers?.[BASE_KEY as never] === "auto";
		const keyStillPresent = Object.hasOwn(readBytes(s3).modelServiceTiers ?? {}, BASE_KEY);

		out("");
		out(`RESULT_ON_RESTART: ${binPass1 ? "PASS" : "FAIL"} (fast still ON; settings priority)`);
		out(`RESULT_OFF_RESTART: ${binPass2 ? "PASS" : "FAIL"} (fast OFF; value "auto" not deleted)`);
		out(`KEY_PRESENT_AS_AUTO: ${keyStillPresent ? "PASS" : "FAIL"}`);
		out(`BINARY_PASS: ${binPass1 && binPass2 && keyStillPresent ? "PASS" : "FAIL"}`);

		expect(binPass1).toBe(true);
		expect(binPass2).toBe(true);
		expect(keyStillPresent).toBe(true);
	});
});

afterAll(() => {
	mkdirSync(join(REPO_ROOT, "local-ignore", "qa-evidence", "20260816-fast-reasoning-effort"), { recursive: true });
	writeFileSync(
		EVIDENCE_FILE,
		`manual-qa task-10 /fast persistence\ndate: ${new Date().toISOString()}\n\n${lines.join("\n")}\n`,
	);
});
