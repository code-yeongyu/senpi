import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueues } from "../../../tools/file-mutation-queue.ts";

export type PatchTransaction = {
	operationIndex: number;
	checkCancelled: () => void;
};

type PatchPathSnapshot =
	| { readonly kind: "missing"; readonly filePath: string }
	| { readonly kind: "file"; readonly filePath: string; readonly bytes: Uint8Array }
	| { readonly kind: "symlink"; readonly filePath: string; readonly target: string };

type PatchTransactionInput<T> = {
	readonly filePaths: readonly string[];
	readonly signal: AbortSignal;
	readonly run: (transaction: PatchTransaction) => Promise<T>;
	readonly onAbort: (error: unknown, transaction: PatchTransaction) => T;
};

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function throwIfCancelled(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("Operation aborted") as NodeJS.ErrnoException;
	error.code = "ABORT_ERR";
	throw error;
}

async function readSnapshot(filePath: string): Promise<PatchPathSnapshot> {
	try {
		const stat = await lstat(filePath);
		if (stat.isSymbolicLink()) return { kind: "symlink", filePath, target: await readlink(filePath) };
		if (!stat.isFile()) throw new Error(`apply_patch cannot transactionally mutate non-file path: ${filePath}`);
		return { kind: "file", filePath, bytes: await readFile(filePath) };
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { kind: "missing", filePath };
		throw error;
	}
}

async function restoreSnapshots(snapshots: readonly PatchPathSnapshot[]): Promise<void> {
	const failures: string[] = [];
	for (const snapshot of [...snapshots].reverse()) {
		try {
			if (snapshot.kind === "missing") {
				await rm(snapshot.filePath, { force: true });
				continue;
			}
			await mkdir(path.dirname(snapshot.filePath), { recursive: true });
			if (snapshot.kind === "file") {
				await writeFile(snapshot.filePath, snapshot.bytes);
				continue;
			}
			await rm(snapshot.filePath, { force: true });
			await symlink(snapshot.target, snapshot.filePath);
		} catch (error) {
			failures.push(`${snapshot.filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`apply_patch rollback failed; workspace state is uncertain:\n${failures.join("\n")}`);
	}
}

export async function runPatchTransaction<T>(input: PatchTransactionInput<T>): Promise<T> {
	const uniquePaths = [...new Set(input.filePaths)];
	return withFileMutationQueues(uniquePaths, async () => {
		throwIfCancelled(input.signal);
		const snapshots = await Promise.all(uniquePaths.map(readSnapshot));
		throwIfCancelled(input.signal);
		const transaction: PatchTransaction = {
			operationIndex: 0,
			checkCancelled: () => throwIfCancelled(input.signal),
		};
		try {
			return await input.run(transaction);
		} catch (error) {
			try {
				await restoreSnapshots(snapshots);
			} catch (rollbackError) {
				throw new Error(
					`${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\nOriginal abort: ${
						error instanceof Error ? error.message : String(error)
					}`,
					{ cause: error },
				);
			}
			return input.onAbort(error, transaction);
		}
	});
}
