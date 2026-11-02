/**
 * Client-tool availability state for the imagegen builtin.
 *
 * The generate_image tool is registered once and gated at call time so a
 * mid-session login or model switch takes effect without a reload. Credentials
 * are re-resolved inside every execute; this module only carries the native
 * bypass seam, which the sibling openai-image-gen builtin wires live once the
 * native server tool ships. Until then it stays false and the client tool owns
 * every image request.
 */

import type { ImageGenAuthRegistry } from "./auth.ts";

export const NATIVE_BYPASS_MESSAGE =
	"Image generation is handled by the provider's native server-side tool for the current model. Call the native image_generation tool instead of generate_image.";

let nativeBypass = false;
let registryOverride: ImageGenAuthRegistry | undefined;

/** Enables or disables deferral to a provider-native image generation tool. */
export function setNativeBypass(enabled: boolean): void {
	nativeBypass = enabled;
}

/** Whether generate_image should defer to a provider-native image generation tool. */
export function isNativeBypass(): boolean {
	return nativeBypass;
}

/**
 * Overrides the registry the tool resolves credentials from. Tests and the
 * arbitration suite use this to force a credential direction, because the
 * builtin provider catalog always contains credential-resolvable gateways and
 * the ambient session registry is therefore never credential-free.
 */
export function setImageGenRegistry(registry: ImageGenAuthRegistry | undefined): void {
	registryOverride = registry;
}

/** The registry override, when one is installed. */
export function imageGenRegistryOverride(): ImageGenAuthRegistry | undefined {
	return registryOverride;
}
