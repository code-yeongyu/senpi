import type { ProcessIdentityResult } from "../../src/utils/process-identity.ts";
import type {
	NativeKernelSessionIdentity,
	NativePresenceHold,
	NativePresenceHoldRequest,
	NativePresencePlacementBinding,
	NativePresenceProbe,
	NativePresenceResult,
	NativeProcessBinding,
	NativeProcessObservation,
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
 *
 * The blocking wait (Revision 7 "Busy owner first", design test 26): `presenceWaitAndAcquire` acquires at once when the
 * object is free and otherwise parks until the kernel releases the holder's lock (`releaseHeld`, the explicit release
 * event, or the holder's own quiescence receipt) or the wait is cancelled; it never polls. The handle it acquires is
 * the retained guard that `presenceProbeRetained` applies the admissibility rules to.
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
	/** Runs once a blocking wait is parked on a held object. */
	readonly onWait?: (request: { readonly presenceId: string; readonly path: string; readonly waitId: string }) => void;
	/** This machine's kernel session (PID 4 creation FILETIME); `null` is an unverified (denied) read. */
	readonly kernelSession?: string | null;
	/** Another machine's disk, copied byte for byte: the same directories and objects, none of them locked. */
	readonly copyOf?: {
		readonly directories: ReadonlyMap<string, FakeDirectory>;
		readonly objects: ReadonlyMap<string, FakeObject>;
	};
	/** The processes this kernel shows the identity adapter; a fresh, empty table when absent. */
	readonly processes?: ReturnType<typeof fakeProcessIdentity>;
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
	/** Wait ID -> the parked blocking wait, resolved by a release event or a cancellation. */
	const waits = new Map<
		string,
		{ readonly presenceId: string; readonly path: string; readonly settle: (result: NativePresenceResult) => void }
	>();
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
	/** The kernel released the lock on `path`: the first parked wait for it acquires, as a `LockFileEx` completion. */
	const releaseHeld = (path: string) => {
		held.delete(path);
		for (const [waitId, wait] of waits) {
			if (wait.path !== path) continue;
			waits.delete(waitId);
			held.set(path, wait.presenceId);
			wait.settle({ status: "acquired" });
			return;
		}
	};
	/** Rules 1-3 as the bridge applies them to an opened handle (crate presence_binding.rs). */
	const admissible = (request: NativePresenceProbe, object: FakeObject) => {
		const directory = directories.get(request.path.slice(0, request.path.lastIndexOf("\\")));
		const session = control.kernelSession;
		return (
			object.content.equals(request.tag) &&
			object.volumeSerial === request.volumeSerial &&
			object.fileId === request.fileId &&
			request.createdLocal &&
			directory?.locality === "local" &&
			(!request.relocated ||
				(session.status === "verified" &&
					request.kernelSession !== null &&
					request.kernelSession === session.creationTime))
		);
	};
	const nameOf = (path: string) => path.slice(path.lastIndexOf("\\") + 1);
	let nextId = 1000 + objects.size + directories.size;
	const canonical = (path: string) => (path.startsWith("\\\\?\\") ? path : `\\\\?\\${path}`);
	const processes = options.processes ?? fakeProcessIdentity();
	const native: NativePresencePlacementBinding = {
		...processes.native,
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
			if (!admissible(request, object)) return { status: "unknown", reason: "inadmissible" };
			held.set(request.path, request.presenceId);
			options.onAcquire?.(request);
			return { status: "acquired" };
		},
		presenceProbeRetained: (request) => {
			calls.push(`presenceProbeRetained ${request.presenceId}`);
			if (held.get(request.path) !== request.presenceId) return { status: "unknown", reason: "not_held" };
			const object = objects.get(request.path);
			if (!object || !admissible(request, object)) {
				// Inadmissible: the retained handle is closed at once.
				held.delete(request.path);
				return { status: "unknown", reason: "inadmissible" };
			}
			return { status: "acquired" };
		},
		presencePreActionCheck: () => ({ status: "unknown", reason: "not_modelled" }),
		presenceWaitAndAcquire: (presenceId, path, waitId) => {
			calls.push(`presenceWaitAndAcquire ${presenceId}`);
			if (!objects.has(path)) return Promise.resolve({ status: "unknown", reason: "os_error", code: 2 });
			if ([...waits.values()].some((wait) => wait.presenceId === presenceId)) {
				return Promise.resolve({ status: "unknown", reason: "wait_pending" });
			}
			if (!held.has(path)) {
				held.set(path, presenceId);
				return Promise.resolve({ status: "acquired" });
			}
			return new Promise<NativePresenceResult>((settle) => {
				waits.set(waitId, { presenceId, path, settle });
				options.onWait?.({ presenceId, path, waitId });
			});
		},
		presenceCancelWait: (waitId) => {
			calls.push(`presenceCancelWait ${waitId}`);
			const wait = waits.get(waitId);
			if (!wait) return;
			waits.delete(waitId);
			wait.settle({ status: "cancelled" });
		},
		presenceReleaseAfterQuiescence: (receipt) => {
			calls.push(`presenceReleaseAfterQuiescence ${receipt.presenceId}`);
			options.onRelease?.(receipt);
			for (const [path, presenceId] of held) {
				if (presenceId !== receipt.presenceId) continue;
				// The holder's clean close releases the kernel lock: a parked wait acquires.
				releaseHeld(path);
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
	return { native, load, calls, directories, objects, held, holds, waits, control, releaseHeld, processes };
}

/**
 * A disk clone or restored image of `machine` booted as another kernel session (design test 23): the same directories
 * and presence objects, byte for byte with the same tags, volume serials and file IDs, and nothing locked.
 */
export function cloneMachine(machine: ReturnType<typeof fakeWindows>, options: FakeWindowsOptions = {}) {
	return fakeWindows({ ...options, copyOf: { directories: machine.directories, objects: machine.objects } });
}

/** What one kernel answers for a PID the identity adapter opens (crate `process_handle.rs`): the facts read on that handle. */
export interface FakeProcess {
	/** `GetProcessId` on the opened handle; defaults to the opened PID. A different value is an inconsistent handle. */
	readonly handlePid?: number | null;
	/** The complete creation FILETIME as a decimal string; `null` is an unreadable `GetProcessTimes`. */
	readonly creationTime: string | null;
	/** The `TokenUser` SID; `null` is an unreadable token. */
	readonly userSid: string | null;
	/** Whether the process object is signalled; `null` is a failed wait. */
	readonly exited?: boolean | null;
	/** `GetExitCodeProcess` of a signalled object. */
	readonly exitCode?: number;
}

/**
 * The Windows process-identity adapter as the #4199 bridge exposes it (design 4.2a "OS identity", clause (ii) of
 * "Process evidence and the kernel-session gate"): `processOpen` opens a PID once, reads `GetProcessId`, the creation
 * FILETIME, the `TokenUser` SID and the exit state on that one handle and RETAINS the handle under the caller's handle ID
 * until `processClose`; `processObserve` rereads the same handle. The table is explicit, never real PID recycling: a PID
 * not in it is `no_such_process`, a denied one is `access_denied`, and a test installs a replacement under a recorded PID
 * with its own creation FILETIME or SID. Nothing here classifies: live, gone and unknown are the caller's rule.
 *
 * The exit wait (`processWaitExit`, design 4.2a "process-object signalling for exit ... not wrapper exit"): a wait on a
 * retained handle parks until the process object is signalled (`signal`), the wait is cancelled, or the handle is closed;
 * it never polls and no ChildProcess is involved.
 */
export function fakeProcessIdentity() {
	const table = new Map<number, FakeProcess | "denied" | "failed">();
	/** Retained handle ID -> the PID it was opened on. A handle keeps the process object: its facts stay readable. */
	const handles = new Map<string, number>();
	/** Wait ID -> the parked exit wait, settled by the object's signal, a cancellation or the handle's close. */
	const exitWaits = new Map<
		string,
		{ readonly handleId: string; readonly pid: number; readonly settle: (result: NativeProcessObservation) => void }
	>();
	const calls: string[] = [];
	const settleExit = (pid: number, exitCode: number) => {
		for (const [waitId, wait] of exitWaits) {
			if (wait.pid !== pid) continue;
			exitWaits.delete(waitId);
			wait.settle({ status: "exited", exitCode });
		}
	};
	const facts = (pid: number, process: FakeProcess): NativeProcessObservation => ({
		status: "opened",
		handlePid: process.handlePid === undefined ? pid : process.handlePid,
		creationTime: process.creationTime,
		userSid: process.userSid,
		exited: process.exited === undefined ? false : process.exited,
	});
	const answer = (pid: number): NativeProcessObservation => {
		const process = table.get(pid);
		if (process === undefined) return { status: "no_such_process" };
		if (process === "denied") return { status: "access_denied" };
		if (process === "failed") return { status: "failed", code: 6 };
		return facts(pid, process);
	};
	const native: NativeProcessBinding = {
		processOpen: (handleId, pid) => {
			calls.push(`processOpen ${pid}`);
			if (handles.has(handleId)) return { status: "held", reason: "handle_in_use" };
			const observation = answer(pid);
			if (observation.status === "opened") handles.set(handleId, pid);
			return observation;
		},
		processObserve: (handleId) => {
			const pid = handles.get(handleId);
			calls.push(`processObserve ${pid ?? "?"}`);
			if (pid === undefined) return { status: "not_held" };
			const process = table.get(pid);
			// The retained handle keeps the process object: a process the table dropped meanwhile is signalled, not absent.
			if (process === undefined || process === "denied" || process === "failed") {
				return { status: "opened", handlePid: pid, creationTime: null, userSid: null, exited: true };
			}
			return facts(pid, process);
		},
		processClose: (handleId) => {
			calls.push(`processClose ${handles.get(handleId) ?? "?"}`);
			if (!handles.delete(handleId)) return { status: "not_held" };
			// A closed handle ends its pending wait: the duplicated wait handle is released, the waiter answers cancelled.
			for (const [waitId, wait] of exitWaits) {
				if (wait.handleId !== handleId) continue;
				exitWaits.delete(waitId);
				wait.settle({ status: "cancelled" });
			}
			return { status: "closed" };
		},
		processWaitExit: (handleId, waitId) => {
			const pid = handles.get(handleId);
			calls.push(`processWaitExit ${pid ?? "?"}`);
			if (pid === undefined) return Promise.resolve({ status: "not_held" });
			if (exitWaits.has(waitId)) return Promise.resolve({ status: "held", reason: "wait_pending" });
			const process = table.get(pid);
			if (typeof process === "object" && process.exited === true) {
				return Promise.resolve({ status: "exited", exitCode: process.exitCode ?? 0 });
			}
			return new Promise<NativeProcessObservation>((settle) => {
				exitWaits.set(waitId, { handleId, pid, settle });
			});
		},
		processCancelWaitExit: (waitId) => {
			calls.push(`processCancelWaitExit`);
			const wait = exitWaits.get(waitId);
			if (!wait) return;
			exitWaits.delete(waitId);
			wait.settle({ status: "cancelled" });
		},
	};
	return {
		table,
		handles,
		exitWaits,
		calls,
		native,
		live(pid: number, creationTime: string, userSid: string) {
			table.set(pid, { creationTime, userSid, exited: false });
		},
		exited(pid: number, creationTime: string, userSid: string) {
			table.set(pid, { creationTime, userSid, exited: true });
		},
		/** The process exits: its object is signalled with `exitCode`, and every wait parked on it answers `exited`. */
		signal(pid: number, exitCode = 0) {
			const process = table.get(pid);
			if (typeof process === "object") table.set(pid, { ...process, exited: true, exitCode });
			settleExit(pid, exitCode);
		},
		denied(pid: number) {
			table.set(pid, "denied");
		},
		/** Every field of `facts` the kernel answers for `pid`, for the unreadable and inconsistent rows of the table. */
		answers(pid: number, process: FakeProcess) {
			table.set(pid, process);
		},
	};
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
