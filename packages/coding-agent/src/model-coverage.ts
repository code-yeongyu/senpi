/**
 * `@code-yeongyu/senpi/model-coverage`: what an embedding launcher needs to check model coverage against this engine
 * without booting it (oh-my-openagent's compiled doctor and setup): the builtin provider catalog, the model runtime with
 * its auth and models stores, the settings manager, and the Anthropic subscription provider. Re-exports only.
 */
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { builtinProviders } from "@earendil-works/pi-ai/providers/all";
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { registerAnthropicSubscriptionExtension } from "./core/extensions/builtin/anthropic-subscription/index.ts";
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { loadAnthropicSubscriptionProviderSettings } from "./core/extensions/builtin/anthropic-subscription/settings.ts";
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { ModelRuntime } from "./core/model-runtime.ts";
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { InMemoryCodingAgentModelsStore } from "./core/models-store.ts";
/** @public package entry `@code-yeongyu/senpi/model-coverage`, read by an embedding launcher (oh-my-openagent) */
export { SettingsManager } from "./core/settings-manager.ts";
