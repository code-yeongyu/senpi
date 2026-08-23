import type { SessionEntry } from "../../../session-manager.ts";

export const BTW_SIDE_ENTRY_TYPE = "btw-side";

export interface BtwSideMetadata {
	version: 1;
	parentSessionPath: string;
	parentSessionId: string;
	parentLeafId?: string | null;
	ordinal: number;
	summary: string;
	createdAt: string;
}

export interface BtwSessionListItem {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	modified: Date;
}

export interface BtwSideSession extends BtwSessionListItem {
	metadata: BtwSideMetadata;
}

export interface BtwSessionCatalog {
	parentSessionPath: string;
	main: BtwSessionListItem | undefined;
	currentSide: BtwSideSession | undefined;
	sides: BtwSideSession[];
	skippedPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBtwSideMetadata(value: unknown): BtwSideMetadata | undefined {
	if (!isRecord(value)) return undefined;
	return value.version === 1 &&
		typeof value.parentSessionPath === "string" &&
		value.parentSessionPath.length > 0 &&
		typeof value.parentSessionId === "string" &&
		value.parentSessionId.length > 0 &&
		(value.parentLeafId === undefined ||
			value.parentLeafId === null ||
			(typeof value.parentLeafId === "string" && value.parentLeafId.length > 0)) &&
		typeof value.ordinal === "number" &&
		Number.isInteger(value.ordinal) &&
		value.ordinal > 0 &&
		typeof value.summary === "string" &&
		value.summary.length > 0 &&
		typeof value.createdAt === "string" &&
		!Number.isNaN(Date.parse(value.createdAt))
		? (value as unknown as BtwSideMetadata)
		: undefined;
}

export function readBtwSideMetadata(entries: readonly SessionEntry[]): BtwSideMetadata | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== BTW_SIDE_ENTRY_TYPE) continue;
		const metadata = parseBtwSideMetadata(entry.data);
		if (metadata) return metadata;
	}
	return undefined;
}

function samePath(left: string, right: string): boolean {
	return left === right;
}

export async function loadBtwSessionCatalog(input: {
	cwd: string;
	currentSessionPath: string;
	listSessions: () => Promise<readonly BtwSessionListItem[]>;
	readMetadata: (sessionPath: string) => Promise<BtwSideMetadata | undefined>;
	readSessionInfo?: (sessionPath: string) => Promise<BtwSessionListItem | undefined>;
}): Promise<BtwSessionCatalog> {
	const sessions = (await input.listSessions()).filter((session) => session.cwd === input.cwd);
	const ensureSession = async (sessionPath: string): Promise<void> => {
		if (sessions.some((session) => samePath(session.path, sessionPath))) return;
		const session = await input.readSessionInfo?.(sessionPath);
		if (session) sessions.push(session);
	};
	await ensureSession(input.currentSessionPath);
	let currentMetadata: BtwSideMetadata | undefined;
	try {
		currentMetadata = await input.readMetadata(input.currentSessionPath);
	} catch {
		currentMetadata = undefined;
	}
	const parentSessionPath = currentMetadata?.parentSessionPath ?? input.currentSessionPath;
	await ensureSession(parentSessionPath);
	const listedMain = sessions.find((session) => samePath(session.path, parentSessionPath));
	const parentSessionId = currentMetadata?.parentSessionId ?? listedMain?.id;
	const main = listedMain && (!currentMetadata || listedMain.id === parentSessionId) ? listedMain : undefined;
	const sides: BtwSideSession[] = [];
	const skippedPaths: string[] = [];

	for (const session of sessions) {
		if (samePath(session.path, parentSessionPath)) continue;
		try {
			const metadata = await input.readMetadata(session.path);
			if (
				!metadata ||
				!samePath(metadata.parentSessionPath, parentSessionPath) ||
				metadata.parentSessionId !== parentSessionId
			) {
				continue;
			}
			sides.push({ ...session, metadata });
		} catch {
			skippedPaths.push(session.path);
		}
	}

	if (currentMetadata && !sides.some((side) => samePath(side.path, input.currentSessionPath))) {
		sides.push({
			id: input.currentSessionPath,
			path: input.currentSessionPath,
			cwd: input.cwd,
			name: `BTW #${currentMetadata.ordinal}: ${currentMetadata.summary}`,
			modified: new Date(currentMetadata.createdAt),
			metadata: currentMetadata,
		});
	}

	sides.sort(
		(left, right) =>
			left.metadata.ordinal - right.metadata.ordinal ||
			left.metadata.createdAt.localeCompare(right.metadata.createdAt) ||
			left.path.localeCompare(right.path),
	);

	return {
		parentSessionPath,
		main,
		currentSide: sides.find((side) => samePath(side.path, input.currentSessionPath)),
		sides,
		skippedPaths,
	};
}
