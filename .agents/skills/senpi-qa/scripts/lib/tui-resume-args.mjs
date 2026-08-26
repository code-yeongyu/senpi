import { createWriteStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { once } from "node:events";
import { isAbsolute, join, posix, relative } from "node:path";
import { finished } from "node:stream/promises";
import { evidenceDir } from "./common.mjs";

export const COLS = 120;
export const ROWS = 34;
export const TUI_ARGS = ["--no-context-files", "--no-skills", "--no-extensions", "--approve", "--tui-mode", "fullscreen"];
export const FIRST_MARKER = "ResumeQaFirstMarkerA1B2C3D4";
export const FINAL_MARKER = "ResumeQaFinalMarkerE5F6G7H8";
export const SESSION_ID = "resume-qa-selected";
export const BOOT_TIMEOUT_MS = 60_000;
export const SELECTOR_TIMEOUT_MS = 30_000;
export const HYDRATE_TIMEOUT_MS = 180_000;
export const TEARDOWN_TIMEOUT_MS = 8_000;
/** Documented safe maximum for `--messages`. The 5000-message load must remain valid. */
export const MAX_MESSAGES = 5000;
export const COMMAND = "node .agents/skills/senpi-qa/scripts/tui-resume.mjs --messages 5000 --select latest --evidence resume-performance";

export function parseMessageBound(raw) {
	const messages = Number(raw);
	if (!Number.isInteger(messages) || messages <= 0) throw new Error("--messages must be a positive integer");
	if (messages > MAX_MESSAGES) throw new Error(`--messages exceeds safe maximum of ${MAX_MESSAGES}`);
	return messages;
}

export const EVIDENCE_PREFIX = "local-ignore/qa-evidence/";
export const EXACT_EVIDENCE_PATH = "local-ignore/qa-evidence/20260820-resume-performance/tui-resume";

function isSafeSegment(segment) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

export function normalizeEvidencePath(raw) {
	if (typeof raw !== "string" || raw.length === 0) throw new Error("--evidence requires a value");
	if (raw.includes("\0") || raw.includes("\\")) throw new Error("--evidence path is not allowed");
	if (isAbsolute(raw) || raw.startsWith("/")) throw new Error("--evidence path must not be absolute");
	const segments = raw.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error("--evidence path must not contain . or ..");
	}
	const normalized = posix.normalize(raw);
	if (!normalized.startsWith(EVIDENCE_PREFIX) || normalized.length <= EVIDENCE_PREFIX.length) {
		throw new Error("--evidence path must stay under local-ignore/qa-evidence/");
	}
	for (const segment of normalized.slice(EVIDENCE_PREFIX.length).split("/")) {
		if (!isSafeSegment(segment)) throw new Error("--evidence path segment is not allowed");
	}
	return normalized;
}

export function parseEvidence(raw) {
	if (typeof raw !== "string" || raw.length === 0) throw new Error("--evidence requires a value");
	if (isSafeSegment(raw)) return raw;
	return normalizeEvidencePath(raw);
}

function assertInsideEvidenceRoot(realRoot, target) {
	const rel = relative(realRoot, target);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("--evidence path must not escape local-ignore/qa-evidence/");
	}
}

export function resolveResumeEvidence(root, evidence) {
	const parsed = parseEvidence(evidence);
	if (isSafeSegment(parsed)) return evidenceDir(parsed);
	const remainder = parsed.slice(EVIDENCE_PREFIX.length);
	const evidenceRoot = join(root, "local-ignore", "qa-evidence");
	mkdirSync(evidenceRoot, { recursive: true });
	const realRoot = realpathSync(evidenceRoot);
	let current = realRoot;
	for (const segment of remainder.split("/")) {
		const next = join(current, segment);
		if (!existsSync(next)) mkdirSync(next, { recursive: true });
		current = realpathSync(next);
		assertInsideEvidenceRoot(realRoot, current);
	}
	return current;
}

export function usage() {
	process.stdout.write(
		`usage: node tui-resume.mjs --messages N --select latest --evidence SLUG\n--messages N is a positive integer up to ${MAX_MESSAGES}\n`,
	);
}

export function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!value || value.startsWith("--")) {
			if (flag !== "--messages" && flag !== "--select" && flag !== "--evidence") {
				throw new Error(`Unknown option: ${flag}`);
			}
			throw new Error(`${flag} requires a value`);
		}
		i += 1;
		switch (flag) {
			case "--messages":
				options.messages = parseMessageBound(value);
				break;
			case "--select":
				if (value !== "latest") throw new Error('--select only supports "latest"');
				options.select = value;
				break;
			case "--evidence":
				options.evidence = parseEvidence(value);
				break;
			default:
				throw new Error(`Unknown option: ${flag}`);
		}
	}
	if (!options.messages || !options.select || !options.evidence) {
		throw new Error("required: --messages N --select latest --evidence SLUG");
	}
	return options;
}

export async function writeSession(path, { sessionId, cwd, messageCount }) {
	const activityBase = Date.now() + 86_400_000;
	const stream = createWriteStream(path);
	const write = async (line) => {
		if (!stream.write(line)) await once(stream, "drain");
	};
	await write(
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date(activityBase).toISOString(),
			cwd,
		})}\n`,
	);
	let parentId = null;
	for (let index = 1; index <= messageCount; index += 1) {
		const id = `msg-${index}`;
		const text = index === 1 ? FIRST_MARKER : index === messageCount ? FINAL_MARKER : `resume-load-probe-${index}`;
		const timestamp = activityBase + index;
		await write(
			`${JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date(timestamp).toISOString(),
				message: { role: "user", content: [{ type: "text", text }], timestamp },
			})}\n`,
		);
		parentId = id;
	}
	stream.end();
	await finished(stream);
}
