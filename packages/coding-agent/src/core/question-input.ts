import type { ExtensionContext } from "./extensions/types.ts";

/** Engine-owned capability, not a user-asserted origin on the extension message API. */
const releases = new WeakMap<ExtensionContext, () => void>();

export function bindQuestionInput(ctx: ExtensionContext, release: () => void): void {
	releases.set(ctx, release);
}

export function releaseQuestionInput(ctx: ExtensionContext): void {
	releases.get(ctx)?.();
}
