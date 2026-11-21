/**
 * Client-tool availability state for the imagegen builtin.
 *
 * The generate_image tool is registered once and gated at call time so a
 * mid-session login or model switch takes effect without a reload. Credentials
 * are re-resolved inside every execute; this module only carries the native
 * bypass seam, which the sibling openai-image-gen builtin drives from its own
 * arbitration. The bypass is recorded per session (keyed by the session's
 * `sessionManager`), because one host process can run several sessions on
 * different models (senpi#5674): a session that never armed the bypass always
 * runs the client tool.
 */

import type { ImageGenAuthRegistry } from "./auth.ts";

export const NATIVE_BYPASS_MESSAGE =
	"Image generation is handled by the provider's native server-side tool for the current model. Call the native image_generation tool instead of generate_image.";

const nativeBypassSessions = new WeakSet<object>();
let registryOverride: ImageGenAuthRegistry | undefined;

/** Enables or disables, for one session, deferral to a provider-native image generation tool. */
export function setNativeBypass(session: object, enabled: boolean): void {
	if (enabled) nativeBypassSessions.add(session);
	else nativeBypassSessions.delete(session);
}

/** Whether generate_image in `session` should defer to a provider-native image generation tool. */
export function isNativeBypass(session: object): boolean {
	return nativeBypassSessions.has(session);
}

/**
 * Overrides the registry the tool resolves credentials from. Tests and the
 * arbitration suite use this to force a credential direction independent of
 * whatever providers the ambient session registry holds.
 */
export function setImageGenRegistry(registry: ImageGenAuthRegistry | undefined): void {
	registryOverride = registry;
}

/** The registry override, when one is installed. */
export function imageGenRegistryOverride(): ImageGenAuthRegistry | undefined {
	return registryOverride;
}
