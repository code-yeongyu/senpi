import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, Model as PiModel } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../config.ts";
import { AuthStorage } from "../../../core/auth-storage.ts";
import { ModelRegistry } from "../../../core/model-registry.ts";
import { defaultModelPerProvider } from "../../../core/model-resolver.ts";
import { getSupportedThinkingLevels } from "../../../core/thinking-levels.ts";
import type {
	ModelListParams,
	ModelListResponse,
	RemoteControlClientListParams,
	Model as WireModel,
} from "../protocol/index.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { MethodRegistry } from "../rpc/registry.ts";

export interface AppServerModelRegistry {
	getAvailable(): PiModel<Api>[];
}

export interface RegisterAppServerModelMethodsOptions {
	readonly modelRegistry?: AppServerModelRegistry;
	readonly agentDir?: string;
}

const DEFAULT_MODEL_IDS = new Map<string, string>(Object.entries(defaultModelPerProvider));
const INSTALLATION_ID_PATH = ["app-server", "installation-id"] as const;
const INSTALLATION_ID_LOCK_SUFFIX = ".lock";
const INSTALLATION_ID_LOCK_MARKER_PREFIX = "owner-";
const INSTALLATION_ID_LOCK_MARKER_SUFFIX = ".json";
const INSTALLATION_ID_LOCK_RETRY_ATTEMPTS = 100;
const INSTALLATION_ID_LOCK_RETRY_MS = 10;
const INSTALLATION_ID_INVALID_LOCK_RECLAIM_MS = 500;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const pendingInstallationIds = new Map<string, Promise<string>>();

type InstallationIdLockMetadata = { readonly ownerToken: string; readonly pid: number; readonly createdAtMs: number };

export function registerAppServerModelMethods(
	registry: MethodRegistry,
	options: RegisterAppServerModelMethodsOptions = {},
): void {
	let defaultModelRegistry: AppServerModelRegistry | undefined;
	const getModelRegistry = () => {
		defaultModelRegistry ??= ModelRegistry.create(AuthStorage.create());
		return options.modelRegistry ?? defaultModelRegistry;
	};

	registry.register("model/list", {
		handler: ({ request }) =>
			buildModelListResponse(getModelRegistry().getAvailable(), parseModelListParams(request.params)),
	});
	registry.register("remoteControl/status/read", {
		experimental: true,
		handler: () => buildRemoteControlStatusReadResponse(options.agentDir ?? getAgentDir()),
	});
	registry.register("remoteControl/client/list", {
		experimental: true,
		handler: ({ request }) => {
			parseRemoteControlClientListParams(request.params);
			throw new Error("remote control is unavailable for this app-server");
		},
	});
}

export function buildModelListResponse(models: readonly PiModel<Api>[], params: ModelListParams): ModelListResponse {
	const data = models
		.map((model) => buildWireModel(model))
		.filter((model) => params.includeHidden === true || !model.hidden);
	return { data, nextCursor: null };
}

export function buildWireModel(model: PiModel<Api>): WireModel {
	return {
		id: `${model.provider}/${model.id}`,
		model: model.id,
		upgrade: null,
		upgradeInfo: null,
		availabilityNux: null,
		displayName: model.name ?? model.id,
		description: "",
		hidden: false,
		supportedReasoningEfforts: model.reasoning
			? getSupportedThinkingLevels(model)
					.filter((level) => level !== "off")
					.map((reasoningEffort) => ({ reasoningEffort, description: "" }))
			: [],
		defaultReasoningEffort: "medium",
		inputModalities: ["text"],
		supportsPersonality: false,
		additionalSpeedTiers: [],
		serviceTiers: [],
		defaultServiceTier: null,
		isDefault: DEFAULT_MODEL_IDS.get(model.provider) === model.id,
	};
}

async function buildRemoteControlStatusReadResponse(agentDir: string) {
	return {
		status: "disabled",
		serverName: "senpi app-server",
		installationId: await ensureInstallationId(agentDir),
		environmentId: null,
	};
}

async function ensureInstallationId(agentDir: string): Promise<string> {
	const installationIdPath = join(agentDir, ...INSTALLATION_ID_PATH);
	const pendingInstallationId = pendingInstallationIds.get(installationIdPath);
	if (pendingInstallationId) return pendingInstallationId;

	const installationId = loadOrCreateInstallationId(installationIdPath);
	pendingInstallationIds.set(installationIdPath, installationId);
	try {
		return await installationId;
	} finally {
		if (pendingInstallationIds.get(installationIdPath) === installationId) {
			pendingInstallationIds.delete(installationIdPath);
		}
	}
}

async function loadOrCreateInstallationId(installationIdPath: string): Promise<string> {
	for (let attempt = 0; attempt < INSTALLATION_ID_LOCK_RETRY_ATTEMPTS; attempt += 1) {
		const existing = await readInstallationId(installationIdPath);
		if (existing) return existing;

		const claimed = await tryCreateInstallationIdUnderLock(installationIdPath);
		if (claimed) return claimed;

		await delay(INSTALLATION_ID_LOCK_RETRY_MS);
	}
	throw new Error(`timed out waiting for installation id lock: ${installationIdPath}`);
}

async function readInstallationId(installationIdPath: string): Promise<string | undefined> {
	try {
		const existing = (await readFile(installationIdPath, "utf8")).trim();
		return UUID_V4_PATTERN.test(existing) ? existing : undefined;
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
		return undefined;
	}
}

async function tryCreateInstallationIdUnderLock(installationIdPath: string): Promise<string | undefined> {
	await mkdir(dirname(installationIdPath), { recursive: true });
	const lockPath = `${installationIdPath}${INSTALLATION_ID_LOCK_SUFFIX}`;
	const ownerToken = randomUUID();
	try {
		await mkdir(lockPath, { mode: 0o700 });
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "EEXIST")) {
			await reclaimAbandonedInstallationIdLock(lockPath);
			return undefined;
		}
		throw error;
	}

	const markerPath = join(
		lockPath,
		`${INSTALLATION_ID_LOCK_MARKER_PREFIX}${ownerToken}${INSTALLATION_ID_LOCK_MARKER_SUFFIX}`,
	);
	let markerCreated = false;
	try {
		await writeFile(markerPath, `${JSON.stringify({ ownerToken, pid: process.pid, createdAtMs: Date.now() })}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		markerCreated = true;
		const existing = await readInstallationId(installationIdPath);
		if (existing) return existing;

		const installationId = randomUUID();
		await writeFile(installationIdPath, `${installationId}\n`, { encoding: "utf8", mode: 0o600 });
		return installationId;
	} finally {
		if (markerCreated) {
			await releaseInstallationIdLock(lockPath, markerPath);
		}
	}
}

async function reclaimAbandonedInstallationIdLock(lockPath: string): Promise<void> {
	const metadata = await readInstallationIdLockMetadata(lockPath);
	if (metadata.kind === "missing" || !isReclaimableInstallationIdLock(metadata)) return;
	if (metadata.markerPath !== undefined) {
		await unlinkInstallationIdLock(metadata.markerPath);
	}
	await removeEmptyInstallationIdLock(lockPath);
}

async function removeEmptyInstallationIdLock(lockPath: string): Promise<void> {
	try {
		await rmdir(lockPath);
	} catch (error: unknown) {
		if (
			isNodeErrorCode(error, "ENOENT") ||
			isNodeErrorCode(error, "ENOTDIR") ||
			isNodeErrorCode(error, "ENOTEMPTY")
		) {
			return;
		}
		throw error;
	}
}

function isReclaimableInstallationIdLock(metadata: InstallationIdLockRead): boolean {
	switch (metadata.kind) {
		case "abandoned":
			return true;
		case "invalid":
			return Date.now() - metadata.mtimeMs >= INSTALLATION_ID_INVALID_LOCK_RECLAIM_MS;
		case "live":
		case "missing":
			return false;
		default: {
			const unreachable: never = metadata;
			return unreachable;
		}
	}
}

type InstallationIdLockRead =
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly mtimeMs: number; readonly markerPath?: string }
	| { readonly kind: "live"; readonly markerPath?: string }
	| { readonly kind: "abandoned"; readonly markerPath?: string };

async function readInstallationIdLockMetadata(lockPath: string): Promise<InstallationIdLockRead> {
	let lockStat: Awaited<ReturnType<typeof stat>>;
	try {
		lockStat = await stat(lockPath);
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return { kind: "missing" };
		throw error;
	}

	if (!lockStat.isDirectory()) {
		return readLegacyInstallationIdLockMetadata(lockPath, lockStat.mtimeMs);
	}

	let entries: string[];
	try {
		entries = await readdir(lockPath);
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return { kind: "missing" };
		if (isNodeErrorCode(error, "ENOTDIR")) {
			return readLegacyInstallationIdLockMetadata(lockPath);
		}
		throw error;
	}

	const markerNames = entries.filter(
		(entry) =>
			entry.startsWith(INSTALLATION_ID_LOCK_MARKER_PREFIX) && entry.endsWith(INSTALLATION_ID_LOCK_MARKER_SUFFIX),
	);
	if (markerNames.length === 0) {
		return { kind: "invalid", mtimeMs: lockStat.mtimeMs };
	}

	let invalidMarkerPath: string | undefined;
	let abandonedMarkerPath: string | undefined;
	for (const markerName of markerNames) {
		const markerPath = join(lockPath, markerName);
		const metadataResult = await readLockFile(markerPath);
		if (metadataResult.kind === "metadata") {
			if (isProcessAlive(metadataResult.metadata.pid)) {
				return { kind: "live", markerPath };
			}
			abandonedMarkerPath ??= markerPath;
			continue;
		}
		if (metadataResult.kind === "invalid") {
			invalidMarkerPath ??= markerPath;
		}
	}
	if (abandonedMarkerPath !== undefined) {
		return { kind: "abandoned", markerPath: abandonedMarkerPath };
	}
	if (invalidMarkerPath !== undefined) {
		return { kind: "invalid", mtimeMs: lockStat.mtimeMs, markerPath: invalidMarkerPath };
	}
	return { kind: "missing" };
}

async function readLegacyInstallationIdLockMetadata(
	lockPath: string,
	knownMtimeMs?: number,
): Promise<InstallationIdLockRead> {
	const metadataResult = await readLockFile(lockPath);
	if (metadataResult.kind === "missing") return { kind: "missing" };
	if (metadataResult.kind === "invalid") {
		if (knownMtimeMs !== undefined) return { kind: "invalid", mtimeMs: knownMtimeMs };
		try {
			const fileStat = await stat(lockPath);
			return { kind: "invalid", mtimeMs: fileStat.mtimeMs };
		} catch (error: unknown) {
			if (isNodeErrorCode(error, "ENOENT")) return { kind: "missing" };
			throw error;
		}
	}
	return isProcessAlive(metadataResult.metadata.pid) ? { kind: "live" } : { kind: "abandoned" };
}

type LockFileRead =
	| { readonly kind: "missing" }
	| { readonly kind: "invalid" }
	| { readonly kind: "metadata"; readonly metadata: InstallationIdLockMetadata };

async function readLockFile(lockPath: string): Promise<LockFileRead> {
	try {
		const parsed: unknown = JSON.parse((await readFile(lockPath, "utf8")).trim());
		return parseInstallationIdLockMetadata(parsed);
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return { kind: "missing" };
		if (error instanceof SyntaxError || isNodeErrorCode(error, "EISDIR")) return { kind: "invalid" };
		throw error;
	}
}

function parseInstallationIdLockMetadata(value: unknown): LockFileRead {
	if (!isRecord(value)) return { kind: "invalid" };
	const { ownerToken, pid, createdAtMs } = value;
	if (typeof ownerToken !== "string" || ownerToken.length === 0) return { kind: "invalid" };
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return { kind: "invalid" };
	if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs) || createdAtMs < 0) return { kind: "invalid" };
	return { kind: "metadata", metadata: { ownerToken, pid, createdAtMs } };
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ESRCH")) return false;
		if (isNodeErrorCode(error, "EPERM")) return true;
		throw error;
	}
}

async function releaseInstallationIdLock(lockPath: string, markerPath: string): Promise<void> {
	await unlinkInstallationIdLock(markerPath);
	await removeEmptyInstallationIdLock(lockPath);
}

async function unlinkInstallationIdLock(lockPath: string): Promise<void> {
	try {
		await unlink(lockPath);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ENOENT") && !isNodeErrorCode(error, "ENOTDIR")) throw error;
	}
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function parseModelListParams(params: unknown): ModelListParams {
	if (!isRecord(params)) {
		return {};
	}
	return { includeHidden: params.includeHidden === true };
}

function parseRemoteControlClientListParams(params: unknown): RemoteControlClientListParams {
	if (!isRecord(params)) {
		throw invalidRemoteControlParams("remoteControl/client/list requires params");
	}
	const environmentId = params.environmentId;
	if (typeof environmentId !== "string") {
		throw invalidRemoteControlParams("remoteControl/client/list requires a string environmentId");
	}
	const cursor = params.cursor;
	if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
		throw invalidRemoteControlParams("remoteControl/client/list received an invalid cursor");
	}
	const limit = params.limit;
	if (
		limit !== undefined &&
		limit !== null &&
		(typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 0xffff_ffff)
	) {
		throw invalidRemoteControlParams("remoteControl/client/list received an invalid limit");
	}
	const order = params.order;
	if (order !== undefined && order !== null && order !== "asc" && order !== "desc") {
		throw invalidRemoteControlParams("remoteControl/client/list received an invalid order");
	}
	return { environmentId, cursor, limit, order };
}

function invalidRemoteControlParams(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
