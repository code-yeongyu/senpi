import type { ProcessIdentityResult } from "../../src/utils/process-identity.ts";
import type {
	NativeKernelSessionIdentity,
	NativePresenceHold,
	NativePresenceHoldRequest,
	NativePresencePlacementBinding,
	NativePresenceProbe,
	NativePresenceResult,
	PresencePlacementLoad,
	PresenceReleasedReceipt,
} from "../../src/modes/rpc/socket-secret-native.ts";

/**
 * A Windows volume and presence registry as the #4199 bridge reports them (design 4.2a "Placement.", Revision 6
 * "Lifetime object and binding"): directories by canonical path, presence objects by path with their content and file ID,
 * and one exclusive lock per object. A probe acquires only an existing, unlocked object whose content and physical
 * identity match the request; contention is `occupied`.
 *
 * Cleanup (Revision 7 "Presence cleanup"): an exclusive hold (share mode 0) succeeds only while no other handle, a lock
 * holder's or another hold, is open on the object; while a hold exists every other open is a sharing violation (32).
 */
export const FAKE_LOCAL_APP_DATA = "C:\\Users\\u\\AppData\\Local";
export const FAKE_KERNEL_SESSION = "133100000000000000";

interface FakeDirectory {
	volumeSerial: string;
	fileId: string;
	locality: "local" | "not_local";
}

export interface FakeWindowsOptions {
	readonly storeLocality?: "local" | "not_local";
	readonly localAppData?: string | null;
	readonly rootLocality?: "local" | "not_local";
	readonly createOutcome?: "exists" | "failed";
	readonly onCreate?: () => void;
	/** Answers every probe with this verdict instead of the lock table. */
	readonly probeOutcome?: NativePresenceResult;
	/** Runs once the lock is taken, before the probe returns. */
	readonly onAcquire?: (request: NativePresenceProbe) => void;
	readonly onRelease?: (receipt: PresenceReleasedReceipt) => void;
	/** Runs once an exclusive hold is taken, before it returns. */
	readonly onHold?: (request: NativePresenceHoldRequest) => void;
	/** This machine's kernel session (PID 4 creation FILETIME); `null` is an unverified (denied) read. */
	readonly kernelSession?: string | null;
	/** Another machine's disk, copied byte for byte: the same directories and objects, none of them locked. */
	readonly copyOf?: {
		readonly directories: ReadonlyMap<string, FakeDirectory>;
		readonly objects: ReadonlyMap<string, FakeObject>;
	};
}

interface FakeObject {
	content: Buffer;
	volumeSerial: string;
	fileId: string;
}

function sessionOf(value: string | null): NativeKernelSessionIdentity {
	return value === null
		? { status: "unverified", creationTime: null, reason: "access_denied" }
		: { status: "verified", creationTime: value, reason: null };
}

export function fakeWindows(options: FakeWindowsOptions = {}) {
	const calls: string[] = [];
	const directories = new Map<string, FakeDirectory>(
		[...(options.copyOf?.directories ?? [])].map(([path, directory]) => [path, { ...directory }]),
	);
	const objects = new Map<string, FakeObject>(
		[...(options.copyOf?.objects ?? [])].map(([path, object]) => [
			path,
			{ ...object, content: Buffer.from(object.content) },
		]),
	);
	/** Locked object path -> the presence ID its holder acquired it as. */
	const held = new Map<string, string>();
	/** Exclusive hold ID -> the object path it holds. */
	const holds = new Map<string, string>();
	/**
	 * `probeOutcome` answers every probe instead of the lock table; tests set it once their setup has run.
	 * `holdOutcome` answers every exclusive hold the same way. `storeLocality` is how the store directory classifies
	 * NOW, and `kernelSession` this machine's current session.
	 */
	const control: {
		probeOutcome?: NativePresenceResult;
		holdOutcome?: NativePresenceHold;
		storeLocality: "local" | "not_local";
		kernelSession: NativeKernelSessionIdentity;
	} = {
		probeOutcome: options.probeOutcome,
		storeLocality: options.storeLocality ?? "local",
		kernelSession: sessionOf(options.kernelSession === undefined ? FAKE_KERNEL_SESSION : options.kernelSession),
	};
	const heldExclusively = (path: string) => [...holds.values()].includes(path);
	const nameOf = (path: string) => path.slice(path.lastIndexOf("\\") + 1);
	let nextId = 1000 + objects.size + directories.size;
	const canonical = (path: string) => (path.startsWith("\\\\?\\") ? path : `\\\\?\\${path}`);
	const native: NativePresencePlacementBinding = {
		__senpiSocketSecretAbi1: () => "1",
		publishNoReplace: () => {
			throw new Error("not used");
		},
		kernelSessionIdentity: () => {
			calls.push("kernelSessionIdentity");
			return control.kernelSession;
		},
		classifyVolume: (path) => {
			calls.push(`classifyVolume ${path}`);
			return { locality: control.storeLocality, reason: null, reportedFileSystem: "NTFS" };
		},
		localAppDataPath: () => {
			calls.push("localAppDataPath");
			const path = options.localAppData === undefined ? FAKE_LOCAL_APP_DATA : options.localAppData;
			return path === null ? { status: "failed", code: 2 } : { status: "found", path };
		},
		presenceRootOpen: (path, create) => {
			calls.push(`presenceRootOpen ${path} ${create}`);
			const key = canonical(path);
			let directory = directories.get(key);
			if (!directory && create) {
				directory = { volumeSerial: "7", fileId: String(nextId++), locality: options.rootLocality ?? "local" };
				directories.set(key, directory);
			}
			if (!directory) return { status: "failed", step: "open", code: 2 };
			return { status: "opened", path: key, ...directory, reason: null, reportedFileSystem: "NTFS" };
		},
		presenceObjectCreate: (request) => {
			calls.push(`presenceObjectCreate ${request.rootPath} ${request.name}`);
			options.onCreate?.();
			const directory = directories.get(request.rootPath);
			if (!directory) return { status: "failed", step: "open_root", code: 2 };
			if (directory.volumeSerial !== request.rootVolumeSerial || directory.fileId !== request.rootFileId) {
				return { status: "root_mismatch" };
			}
			if (directory.locality !== "local") return { status: "root_not_local", reason: "driver_not_in_path" };
			if (options.createOutcome === "exists") return { status: "exists" };
			if (options.createOutcome === "failed") return { status: "failed", step: "flush", code: 112 };
			const path = `${request.rootPath}\\${request.name}`;
			if (objects.has(path)) return { status: "exists" };
			const fileId = String(nextId++);
			objects.set(path, { content: Buffer.from(request.header), volumeSerial: directory.volumeSerial, fileId });
			return {
				status: "created",
				volumeSerial: directory.volumeSerial,
				fileId,
				locality: "local",
				reason: null,
				reportedFileSystem: "NTFS",
			};
		},
		presenceAcquire: (presenceId) => {
			calls.push(`presenceAcquire ${presenceId}`);
			return { status: "unknown", reason: "not_modelled" };
		},
		presenceProbe: (request) => {
			calls.push(`presenceProbe ${request.presenceId}`);
			if (control.probeOutcome) return control.probeOutcome;
			const object = objects.get(request.path);
			if (!object) return { status: "unknown", reason: "os_error", code: 2 };
			// An exclusive hold shares nothing: the probe's open itself fails with ERROR_SHARING_VIOLATION.
			if (heldExclusively(request.path)) return { status: "unknown", reason: "os_error", code: 32 };
			if (held.has(request.path)) return { status: "occupied" };
			// The bridge's admissibility (crate presence_binding.rs): rule 1 tag and identity, rule 2 recorded local and the
			// object's own handle local now, rule 3 for a relocated object a verified, equal kernel session.
			const directory = directories.get(request.path.slice(0, request.path.lastIndexOf("\\")));
			const session = control.kernelSession;
			if (
				!object.content.equals(request.header) ||
				object.volumeSerial !== request.volumeSerial ||
				object.fileId !== request.fileId ||
				!request.createdLocal ||
				directory?.locality !== "local" ||
				(request.relocated &&
					(session.status !== "verified" ||
						request.kernelSession === null ||
						request.kernelSession !== session.creationTime))
			) {
				return { status: "unknown", reason: "inadmissible" };
			}
			held.set(request.path, request.presenceId);
			options.onAcquire?.(request);
			return { status: "acquired" };
		},
		// The retained-guard check applies the probe's rules to a guard this fake already holds for the path.
		presenceProbeRetained: (request) => {
			calls.push(`presenceProbeRetained ${request.presenceId}`);
			if (held.get(request.path) !== request.presenceId) return { status: "unknown", reason: "not_held" };
			const object = objects.get(request.path);
			if (
				!object ||
				!object.content.equals(request.header) ||
				object.volumeSerial !== request.volumeSerial ||
				object.fileId !== request.fileId ||
				!request.createdLocal
			) {
				held.delete(request.path);
				return { status: "unknown", reason: "inadmissible" };
			}
			return { status: "acquired" };
		},
		presencePreActionCheck: () => ({ status: "unknown", reason: "not_modelled" }),
		presenceWaitAndAcquire: async () => ({ status: "unknown", reason: "not_modelled" }),
		presenceCancelWait: () => {},
		presenceReleaseAfterQuiescence: (receipt) => {
			calls.push(`presenceReleaseAfterQuiescence ${receipt.presenceId}`);
			options.onRelease?.(receipt);
			for (const [path, presenceId] of held) {
				if (presenceId !== receipt.presenceId) continue;
				held.delete(path);
				return { status: "released" };
			}
			return { status: "unknown", reason: "not_held" };
		},
		presenceRootList: (path) => {
			calls.push(`presenceRootList ${path}`);
			const root = canonical(path);
			if (!directories.has(root)) return { status: "failed", step: "read_dir", code: 3 };
			const names = [...objects.keys()]
				.filter((object) => object.slice(0, object.lastIndexOf("\\")) === root)
				.map(nameOf)
				.sort();
			return { status: "listed", names };
		},
		presenceObjectHold: (request) => {
			calls.push(`presenceObjectHold ${nameOf(request.path)}`);
			if (control.holdOutcome) return control.holdOutcome;
			if (holds.has(request.holdId)) return { status: "failed", step: "hold_id", code: 0 };
			const object = objects.get(request.path);
			if (!object) return { status: "missing" };
			// Share mode 0 against a lock holder's handle, or against another hold, is a sharing violation either way.
			if (held.has(request.path) || heldExclusively(request.path)) return { status: "busy" };
			holds.set(request.holdId, request.path);
			options.onHold?.(request);
			return {
				status: "held",
				volumeSerial: object.volumeSerial,
				fileId: object.fileId,
				header: Buffer.from(object.content),
			};
		},
		presenceObjectRelease: (holdId, deleteObject) => {
			const path = holds.get(holdId);
			calls.push(
				`presenceObjectRelease ${path === undefined ? "?" : nameOf(path)} ${deleteObject ? "delete" : "close"}`,
			);
			if (path === undefined) return { status: "failed", step: "hold_id", code: 0 };
			holds.delete(holdId);
			if (!deleteObject) return { status: "closed" };
			objects.delete(path);
			return { status: "deleted" };
		},
	};
	const load: PresencePlacementLoad = { status: "available", native };
	return { native, load, calls, directories, objects, held, holds, control };
}

/**
 * A disk clone or restored image of `machine` booted as another kernel session (design test 23): the same directories
 * and presence objects, byte for byte with the same tags, volume serials and file IDs, and nothing locked.
 */
export function cloneMachine(machine: ReturnType<typeof fakeWindows>, options: FakeWindowsOptions = {}) {
	return fakeWindows({ ...options, copyOf: { directories: machine.directories, objects: machine.objects } });
}

/**
 * The processes one kernel shows a PID reopen (design test 11): an explicit table, never real PID recycling. A PID not
 * in the table is absent; a test installs a replacement under a recorded PID with its own creation FILETIME.
 */
export function fakeProcessTable() {
	const table = new Map<number, ProcessIdentityResult>();
	const observed: number[] = [];
	return {
		table,
		observed,
		live(pid: number, creationTime: string) {
			table.set(pid, { kind: "present", identity: creationTime });
		},
		denied(pid: number) {
			table.set(pid, { kind: "error", error: new Error(`OpenProcess(${pid}) failed: access denied`) });
		},
		observe: async (pid: number): Promise<ProcessIdentityResult> => {
			observed.push(pid);
			return table.get(pid) ?? { kind: "absent" };
		},
	};
}
