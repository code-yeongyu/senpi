import type { DurableStore, StoreWrite } from "../store.ts";
import { createAdmissionLine } from "../store-admission.ts";
import type { Wake } from "../wake-host.ts";

const TASK_PREFIX = "task/";

/** A minimal loop over the store: tasks due at a time, each run in one commit. Enough to observe wake ordering. */
export interface TestLoop {
	/** Schedule task `id` at `due`, in one commit. */
	schedule(id: string, due: number): Promise<void>;
	/** Run every due task, one commit each: a `ran` record and the task's removal, atomically. */
	resume(): Promise<void>;
	/** `active` while a task is due now; `at`, the earliest task due later. */
	wake(): Wake;
}

export async function openTestLoop(
	store: DurableStore,
	epoch: number,
	now: () => number,
	committed: () => Promise<void>,
): Promise<TestLoop> {
	const line = createAdmissionLine();
	const tasks = new Map<string, number>();
	for (const document of await store.scanDocuments(TASK_PREFIX)) {
		if (typeof document.data === "number") tasks.set(document.key.slice(TASK_PREFIX.length), document.data);
	}
	const commit = async (writes: readonly StoreWrite[], adopt: () => void): Promise<void> => {
		await store.commit(epoch, writes, adopt);
		await committed();
	};
	return {
		schedule: (id, due) =>
			line.admit(() => commit([{ op: "put", key: TASK_PREFIX + id, data: due }], () => void tasks.set(id, due))),
		resume: () =>
			line.admit(async () => {
				const due = [...tasks].filter(([, at]) => at <= now()).sort(([a, x], [b, y]) => x - y || (a < b ? -1 : 1));
				for (const [id] of due) {
					const writes: StoreWrite[] = [
						{ op: "append", id: `ran:${id}`, kind: "ran", data: { id } },
						{ op: "delete", key: TASK_PREFIX + id },
					];
					await commit(writes, () => void tasks.delete(id));
				}
			}),
		wake: () => {
			const time = now();
			let active = false;
			let at: number | undefined;
			for (const due of tasks.values()) {
				if (due <= time) active = true;
				else if (at === undefined || due < at) at = due;
			}
			return at === undefined ? { active } : { active, at };
		},
	};
}
