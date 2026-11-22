import { relative, sep } from "node:path";
import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import type { FileSignature, GitOutcome, RunGit, ScanFs } from "../../src/written-files/scan-boundaries.ts";
import { WrittenFiles } from "../../src/written-files/written-files.ts";
import { fakeExtensionContext } from "./fakes.ts";

type ReportToolResult = ExtensionToolContext["reportToolResult"];
export type ReportedResult = Parameters<ReportToolResult>[0];

/**
 * An in-memory repository behind the two boundaries the written-files check reads through: every write advances a
 * virtual clock, so signatures differ without real time, and `git status` lists what differs from the last commit.
 */
export class FakeWorkspace {
	readonly cwd = sep === "/" ? "/work" : "C:\\work";
	readonly gitCalls: string[][] = [];
	/** When set, `git status` answers with it instead of the repository's state. */
	statusOutcome: GitOutcome | undefined;
	readonly #files = new Map<string, { readonly bytes: Uint8Array; readonly signature: FileSignature }>();
	readonly #committed = new Map<string, string>();
	#clock = 0;

	write(path: string, content: string | Uint8Array): void {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		this.#clock += 1;
		const signature = { size: bytes.length, mtimeMs: this.#clock, ctimeMs: this.#clock, ino: 1 };
		this.#files.set(path, { bytes, signature });
	}

	commit(): void {
		this.#committed.clear();
		for (const [path, file] of this.#files) this.#committed.set(path, new TextDecoder().decode(file.bytes));
	}

	absolute(path: string): string {
		return [this.cwd, ...path.split("/")].join(sep);
	}

	readonly fs: ScanFs = {
		stat: async (path) => this.#files.get(this.#relative(path))?.signature,
		read: async (path, limit) => this.#files.get(this.#relative(path))?.bytes.subarray(0, limit),
	};

	readonly git: RunGit = async (args) => {
		this.gitCalls.push([...args]);
		if (args[0] === "rev-parse") return { kind: "ok", stdout: `${this.cwd}\n\n` };
		if (args[0] !== "status") return { kind: "exit", code: 1 };
		if (this.statusOutcome !== undefined) return this.statusOutcome;
		const records = ["# branch.oid 1111111111111111111111111111111111111111", "# branch.head main"];
		for (const [path, file] of this.#files) {
			const committed = this.#committed.get(path);
			if (committed === undefined) records.push(`? ${path}`);
			else if (committed !== new TextDecoder().decode(file.bytes))
				records.push(`1 .M N... 100644 100644 100644 aaaa bbbb ${path}`);
		}
		return { kind: "ok", stdout: `${records.join("\0")}\0` };
	};

	#relative(path: string): string {
		return relative(this.cwd, path).split(sep).join("/");
	}
}

export interface WrittenFilesHarness {
	readonly workspace: FakeWorkspace;
	readonly writtenFiles: WrittenFiles;
	/** Every result the cell reported to the host's `tool_result` handlers, in order. */
	readonly reported: ReportedResult[];
	readonly ctx: ExtensionToolContext;
}

/** `hooks` stands for the session's `tool_result` handlers; by default they change nothing. */
export function writtenFilesHarness(
	hooks?: ReportToolResult,
	options: { readonly hooksRunHere?: () => boolean } = {},
): WrittenFilesHarness {
	const workspace = new FakeWorkspace();
	const reported: ReportedResult[] = [];
	const ctx: ExtensionToolContext = {
		...fakeExtensionContext(),
		cwd: workspace.cwd,
		reportToolResult: async (report) => {
			reported.push(report);
			return hooks === undefined
				? { toolCallId: `cell/reported-${reported.length}`, result: undefined, failures: [] }
				: await hooks(report);
		},
	};
	const writtenFiles = new WrittenFiles({
		cwd: workspace.cwd,
		artifactsDir: workspace.absolute("artifacts"),
		git: workspace.git,
		fs: workspace.fs,
		...options,
	});
	return { workspace, writtenFiles, reported, ctx };
}
