/**
 * `@code-yeongyu/senpi/model-coverage`: what an embedding launcher needs to check model coverage against this engine
 * without booting it (oh-my-openagent's compiled doctor and setup): the builtin provider catalog, the model runtime with
 * its auth and models stores, the settings manager, and the Anthropic subscription provider. Re-exports only.
 */
export { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
export { registerAnthropicSubscriptionExtension } from "./core/extensions/builtin/anthropic-subscription/index.ts";
export { loadAnthropicSubscriptionProviderSettings } from "./core/extensions/builtin/anthropic-subscription/settings.ts";
export { ModelRuntime } from "./core/model-runtime.ts";
export { InMemoryCodingAgentModelsStore } from "./core/models-store.ts";
export { SettingsManager } from "./core/settings-manager.ts";
