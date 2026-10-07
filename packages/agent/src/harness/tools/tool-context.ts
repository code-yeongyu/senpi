import type { ExecutionEnv } from "../types.ts";

/** Mutation that triggered a `postMutate` hook run. */
export interface PostMutateContext {
	/** Tool that performed the mutation. */
	tool: "write" | "edit";
	/** Absolute path of the file that was just written. */
	path: string;
	/** Abort signal of the originating tool call, when the caller supplied one. */
	signal?: AbortSignal;
}

/** Outcome reported by a `postMutate` hook. */
export interface PostMutateResult {
	/** Whether the hook itself rewrote the file after the tool's own write landed. */
	changed: boolean;
	/** Single-line note appended to the tool result text. */
	note?: string;
}

/** Hook invoked inside the file mutation queue, immediately after a tool write succeeds. */
export type PostMutateHook = (input: PostMutateContext) => Promise<PostMutateResult>;

/** Filesystem and shell context required by the built-in execution tools. */
export interface ExecutionToolContext {
	env: ExecutionEnv;
	/**
	 * Optional post-write hook (formatting, codegen, normalization). It runs inside the same
	 * mutation-queue slot as the write it follows, so the file cannot be mutated in between.
	 * A rejecting hook never discards the landed write; the tool appends a warning note instead.
	 */
	postMutate?: PostMutateHook;
}
