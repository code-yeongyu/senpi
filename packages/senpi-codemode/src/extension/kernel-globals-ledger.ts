import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LostGlobals } from "../kernels/shared/kernel-death.ts";
import type { EvalKernelResult, EvalLanguage } from "../tool/types.ts";

const NONE: LostGlobals = { names: [], count: 0 };

/**
 * The user globals a session's kernel holds, as its newest result reported them, kept in memory and in
 * the session's artifacts directory. A death names them in its restart notice; a later session-manager
 * generation (reload, host restart, resume) reads the file and names what its predecessor took with it.
 * The file is a diagnostic: when it cannot be read or written the notice names fewer globals, nothing else.
 */
export class KernelGlobalsLedger {
	readonly #path: string | undefined;
	#current: LostGlobals = NONE;
	#inherited: LostGlobals;
	#writes: Promise<void> = Promise.resolve();
	#written = "";

	private constructor(path: string | undefined, inherited: LostGlobals) {
		this.#path = path;
		this.#inherited = inherited;
		this.#written = serialize(inherited);
	}

	static inMemory(): KernelGlobalsLedger {
		return new KernelGlobalsLedger(undefined, NONE);
	}

	static async open(artifactsDir: string | undefined, language: EvalLanguage): Promise<KernelGlobalsLedger> {
		if (artifactsDir === undefined) return KernelGlobalsLedger.inMemory();
		const path = join(artifactsDir, "kernels", `${language}-globals.json`);
		return new KernelGlobalsLedger(path, await readLedger(path));
	}

	/** What an earlier kernel of this session held when it ended, once; empty when it held nothing. */
	takeInherited(): LostGlobals {
		const inherited = this.#inherited;
		this.#inherited = NONE;
		return inherited;
	}

	takeLost(): LostGlobals {
		const lost = this.#current;
		this.#record(NONE);
		return lost;
	}

	observe(result: EvalKernelResult): void {
		if (result.globalNames === undefined) return;
		this.#record({ names: result.globalNames, count: result.globalCount ?? result.globalNames.length });
	}

	/** A reset discards every global on purpose: nothing is lost that a later notice should name. */
	clear(): void {
		this.#inherited = NONE;
		this.#record(NONE);
	}

	flush(): Promise<void> {
		return this.#writes;
	}

	#record(globals: LostGlobals): void {
		this.#current = globals;
		const path = this.#path;
		const text = serialize(globals);
		if (path === undefined || text === this.#written) return;
		this.#written = text;
		this.#writes = this.#writes.then(() => writeLedger(path, text)).catch(() => undefined);
	}
}

function serialize(globals: LostGlobals): string {
	return JSON.stringify({ names: globals.names, count: globals.count });
}

async function writeLedger(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const staging = `${path}.${process.pid}.tmp`;
	await writeFile(staging, text);
	await rename(staging, path);
}

async function readLedger(path: string): Promise<LostGlobals> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return NONE;
	}
	if (typeof parsed !== "object" || parsed === null) return NONE;
	const names = "names" in parsed && Array.isArray(parsed.names) ? parsed.names.filter(isName) : [];
	const count = "count" in parsed && typeof parsed.count === "number" ? parsed.count : names.length;
	return { names, count: Math.max(count, names.length) };
}

function isName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
