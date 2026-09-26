import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, type Json } from "./agent.ts";
import { countCanaryDialogs, openTextEdit, quitTextEdit, settle, textEditText, workDir } from "./fixtures.ts";
import { command, launcherPermissions } from "./observer.ts";
import {
	clickCode,
	onWindow,
	type RunOptions,
	type ScenarioResult,
	toolError,
	warmUp,
	withSession,
} from "./scenario.ts";

const PREFLIGHT_CAPABILITIES = {
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	stopPath: "global",
	backgroundWindowInput: true,
} as const;

function recordOf(value: unknown): Json {
	return isRecord(value) ? value : {};
}

export async function preflight(): Promise<ScenarioResult> {
	const host = {
		productVersion: await command("/usr/bin/sw_vers", ["-productVersion"]),
		buildVersion: await command("/usr/bin/sw_vers", ["-buildVersion"]),
		arch: await command("/usr/bin/uname", ["-m"]),
		launchdSession: await command("/bin/launchctl", ["managername"]),
	};
	const probe = join(workDir, "probe.png");
	const screencapture = await command("/usr/sbin/screencapture", ["-x", probe])
		.then(() => statSync(probe).size > 0)
		.catch(() => false);
	const launcher = await launcherPermissions();
	return withSession({}, async (session) => {
		const outcome = await session.call({ action: "capabilities" });
		const capabilities = recordOf(outcome.details.value);
		const matches = Object.entries(PREFLIGHT_CAPABILITIES).every(([key, value]) => capabilities[key] === value);
		const facts = { host, capabilities, expected: PREFLIGHT_CAPABILITIES, launcher, screencapture };
		const launcherOk = launcher.accessibilityTrusted && launcher.screenCaptureAccess && screencapture;
		return { scenario: "preflight", pass: !outcome.isError && matches && launcherOk, facts };
	});
}

const STOP_CHORD = "ctrl+alt+cmd+escape";

/** The `suspended` flag of `/computer status`'s `stop: stopPath=<kind> suspended=<bool>[ reason=...]` line. */
function statusSuspended(status: string): boolean | null {
	const flag = /^stop: stopPath=\S+ suspended=(true|false)\b/m.exec(status)?.[1];
	return flag === undefined ? null : flag === "true";
}
const LONG_TEXT = "0123456789".repeat(200);

async function kvmShot(options: RunOptions, jetkvm: string, name: string): Promise<string | null> {
	if (options.kvmShots === undefined) return null;
	const output = join(options.kvmShots, name);
	return command(jetkvm, ["screenshot", "--output", output]).then(() => output);
}

export async function killswitchRealHid(options: RunOptions): Promise<ScenarioResult> {
	const doc = "qa-killswitch.txt";
	const { jetkvm } = options;
	if (jetkvm === undefined) {
		return { scenario: "killswitch-real-hid", pass: false, facts: { error: "JETKVM is not set" } };
	}
	await quitTextEdit();
	await openTextEdit(doc, "");
	try {
		return await withSession({}, async (session) => {
			const typing = session.call(
				onWindow(doc, `await w.type(${JSON.stringify(LONG_TEXT)}, { delivery: "background" });`),
			);
			await settle(
				"typing started",
				() => textEditText(doc),
				(text) => text.length > 20,
			);
			const shotBefore = await kvmShot(options, jetkvm, "killswitch-before.png");
			await command(jetkvm, ["key", "chord", STOP_CHORD]);
			const typed = await typing;
			const typedLength = (await textEditText(doc)).length;
			const shotAfter = await kvmShot(options, jetkvm, "killswitch-after.png");
			// The engine's persisted audit, read from disk: the code each action ended with.
			const suspended = (action: string) =>
				session.auditLog().filter((record) => record.action === action && record.code === "Suspended").length;
			const typeSuspended = suspended("typeText") === 1;
			const blocked = await session.call(clickCode(doc, "background"));
			const clickSuspended = blocked.isError && suspended("click") === 1;
			const status = await session.command("status");
			const resume = await session.command("resume");
			const statusAfterResume = await session.command("status");
			const resumed = await session.call(clickCode(doc, "background"));
			const facts = {
				chord: STOP_CHORD,
				typeError: toolError(typed),
				typedLength,
				audit: session.auditLog(),
				auditTypeSuspended: typeSuspended,
				clickWhileSuspended: toolError(blocked),
				auditClickSuspended: clickSuspended,
				status,
				statusShowsSuspended: statusSuspended(status) === true,
				resume,
				statusAfterResume,
				statusAfterResumeSuspended: statusSuspended(statusAfterResume),
				resumeOk:
					!resumed.isError && /suspended=false/.test(resume) && statusSuspended(statusAfterResume) === false,
				resumedClickError: toolError(resumed),
				kvmScreenshots: [shotBefore, shotAfter],
			};
			const truncated = typedLength < LONG_TEXT.length;
			const pass = truncated && typeSuspended && clickSuspended && facts.statusShowsSuspended && facts.resumeOk;
			return { scenario: "killswitch-real-hid", pass, facts };
		});
	} finally {
		await quitTextEdit();
	}
}

const BUDGET_BYTES = 200_000;

/** `sips` (not the engine) reads an image file's format and pixel width. */
async function imageFacts(path: string): Promise<{ readonly format: string | null; readonly width: number | null }> {
	const out = await command("/usr/bin/sips", ["-g", "format", "-g", "pixelWidth", path]);
	const width = /pixelWidth: (\d+)/.exec(out)?.[1];
	return { format: /format: (\w+)/.exec(out)?.[1] ?? null, width: width === undefined ? null : Number(width) };
}

/** One desktop screenshot under `computer` settings: what the model received, and what reached disk. */
function budgetCapture(computer: Json, label: string) {
	return withSession(computer, async (session) => {
		const outcome = await session.call({ action: "call", chain: [{ method: "screenshot" }] });
		const frame = recordOf(outcome.details.value);
		const inline = outcome.images[0];
		const inlineFile = join(workDir, `${label}-inline.img`);
		if (inline !== undefined) writeFileSync(inlineFile, Buffer.from(inline.data, "base64"));
		const artifact = typeof frame.path === "string" ? frame.path : null;
		return {
			settings: computer,
			error: toolError(outcome),
			inlineMimeType: inline?.mimeType ?? null,
			inlineBytes: inline === undefined ? null : Buffer.byteLength(inline.data, "base64"),
			inlineImage: inline === undefined ? null : await imageFacts(inlineFile),
			displayedWidth: frame.width ?? null,
			sourceWidth: frame.sourceWidth ?? null,
			artifactPath: artifact,
			artifactBytes: artifact === null ? null : (statSync(artifact, { throwIfNoEntry: false })?.size ?? null),
			artifactImage: artifact === null ? null : await imageFacts(artifact),
		};
	});
}

/**
 * The engine writes an artifact only when even the JPEG misses the budget (PNG -> JPEG q70 -> artifact-only,
 * IS-7), so one capture cannot be both inline JPEG and artifact: the JPEG leg adds a dimension cap (the source
 * is 1920 px wide here), the artifact leg is the bare 200000-byte budget.
 */
export async function screenshotBudget(): Promise<ScenarioResult> {
	const jpeg = await budgetCapture({ screenshotMaxBytes: BUDGET_BYTES, maxWidth: 1280, maxHeight: 720 }, "jpeg");
	const artifact = await budgetCapture({ screenshotMaxBytes: BUDGET_BYTES }, "artifact");
	const jpegOk =
		jpeg.inlineMimeType === "image/jpeg" &&
		jpeg.inlineImage?.format === "jpeg" &&
		(jpeg.inlineBytes ?? Number.POSITIVE_INFINITY) <= BUDGET_BYTES &&
		typeof jpeg.sourceWidth === "number" &&
		jpeg.sourceWidth > (jpeg.inlineImage?.width ?? Number.POSITIVE_INFINITY);
	const artifactOk =
		artifact.inlineMimeType === null &&
		artifact.artifactBytes !== null &&
		artifact.artifactImage?.width === artifact.sourceWidth;
	return { scenario: "screenshot-budget", pass: jpegOk && artifactOk, facts: { jpeg, artifact, jpegOk, artifactOk } };
}

export async function capabilitiesTruth(): Promise<ScenarioResult> {
	const doc = "qa-capabilities.txt";
	await quitTextEdit();
	await openTextEdit(doc, "capabilities\n");
	try {
		const launcher = await launcherPermissions();
		return await withSession({}, async (session) => {
			const warm = await warmUp(session, doc);
			const capabilities = recordOf((await session.call({ action: "capabilities" })).details.value);
			const expected = launcher.skylightSpi && launcher.accessibilityTrusted && !warm.isError;
			const facts = {
				launcher,
				canaryWarmUpError: toolError(warm),
				expectedBackgroundWindowInput: expected,
				capabilities,
			};
			const pass =
				capabilities.backgroundWindowInput === expected &&
				capabilities.screenLocked === false &&
				!launcher.screenLocked;
			return { scenario: "capabilities-truth", pass, facts };
		});
	} finally {
		await quitTextEdit();
	}
}

export async function canary(): Promise<ScenarioResult> {
	const doc = "qa-canary.txt";
	await quitTextEdit();
	await openTextEdit(doc, "canary target\n");
	try {
		return await withSession({ macosCanary: "session" }, async (session) => {
			const counter = await countCanaryDialogs();
			const first = await warmUp(session, doc);
			const second = await session.call(clickCode(doc, "background"));
			const dialogs = await counter.stop();
			const facts = { firstError: toolError(first), secondError: toolError(second), canaryDialogPids: dialogs };
			return { scenario: "canary", pass: !first.isError && !second.isError && dialogs.length === 1, facts };
		});
	} finally {
		await quitTextEdit();
	}
}
