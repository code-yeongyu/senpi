import type { SessionEntry } from "../../../session-manager.ts";

export const BTW_SIDE_ENTRY_TYPE = "btw-side";

export interface BtwSideMetadata {
	version: 1;
	parentSessionPath: string;
	parentSessionId: string;
	ordinal: number;
	summary: string;
	createdAt: string;
}

export interface BtwSessionListItem {
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

function isBtwSideMetadata(value: unknown): value is BtwSideMetadata {
	if (!isRecord(value)) return false;
	return (
		value.version === 1 &&
		typeof value.parentSessionPath === "string" &&
		value.parentSessionPath.length > 0 &&
		typeof value.parentSessionId === "string" &&
		value.parentSessionId.length > 0 &&
		typeof value.ordinal === "number" &&
		Number.isInteger(value.ordinal) &&
		value.ordinal > 0 &&
		typeof value.summary === "string" &&
		value.summary.length > 0 &&
		typeof value.createdAt === "string" &&
		!Number.isNaN(Date.parse(value.createdAt))
	);
}

export function readBtwSideMetadata(entries: readonly SessionEntry[]): BtwSideMetadata | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== BTW_SIDE_ENTRY_TYPE) continue;
		if (isBtwSideMetadata(entry.data)) return entry.data;
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
	readEntries: (sessionPath: string) => Promise<readonly SessionEntry[]>;
}): Promise<BtwSessionCatalog> {
	const sessions = (await input.listSessions()).filter((session) => session.cwd === input.cwd);
	let currentMetadata: BtwSideMetadata | undefined;
	try {
		currentMetadata = readBtwSideMetadata(await input.readEntries(input.currentSessionPath));
	} catch {
		currentMetadata = undefined;
	}
	const parentSessionPath = currentMetadata?.parentSessionPath ?? input.currentSessionPath;
	const main = sessions.find((session) => samePath(session.path, parentSessionPath));
	const sides: BtwSideSession[] = [];
	const skippedPaths: string[] = [];

	for (const session of sessions) {
		if (samePath(session.path, parentSessionPath)) continue;
		try {
			const metadata = readBtwSideMetadata(await input.readEntries(session.path));
			if (!metadata || !samePath(metadata.parentSessionPath, parentSessionPath)) continue;
			sides.push({ ...session, metadata });
		} catch {
			skippedPaths.push(session.path);
		}
	}

	if (currentMetadata && !sides.some((side) => samePath(side.path, input.currentSessionPath))) {
		sides.push({
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
