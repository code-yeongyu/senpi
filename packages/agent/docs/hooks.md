# AgentHarness hooks design

This document describes the target hook system for `AgentHarness` and app-specific harness integrations.

## Goals

- `AgentHarness` emits hook events and consumes typed results.
- Hook registration, provenance, cleanup, and mutation-chain semantics live in the hooks implementation.
- There is one registration API and one emission API.
- Observational and mutation hooks use the same registration API; the event result type determines whether a handler can return a result.
- Apps can extend the event union, context type, source/provenance type, and reducers without changing `AgentHarness`.
- Resources and tools carry provenance on their app-specific concrete value types. Hook handlers carry provenance as registration sidecar metadata.

## Value provenance

For non-hook values, provenance belongs on the app-specific concrete type.

```ts
interface AppSource {
	path: string;
	scope: "user" | "project" | "temporary";
}

type AppSkill = Skill & { source: AppSource };
type AppPromptTemplate = PromptTemplate & { source: AppSource };
type AppTool = AgentTool & { source: AppSource };
```

The harness already accepts generic resource/tool types, so no wrapper such as `{ value, source }` is needed.

```ts
const harness = new AgentHarness<AppSkill, AppPromptTemplate, AppTool>({
	resources: { skills, promptTemplates },
	tools,
	// ...
});
```

Loaders such as `loadSourcedSkills()` and `loadSourcedPromptTemplates()` can map source metadata onto the concrete app value type before passing values to the harness.

## Hook event typing

Each hook event owns its handler result type through a type-only phantom field.

```ts
declare const HookResult: unique symbol;

export interface HookEvent<TType extends string, TResult = void> {
	type: TType;
	readonly [HookResult]?: TResult;
}

export type ResultOf<TEvent> = TEvent extends { readonly [HookResult]?: infer TResult } ? TResult : void;
```

Observational events omit the result type:

```ts
interface MessageStartEvent extends HookEvent<"message_start"> {
	type: "message_start";
	message: AgentMessage;
}
```

Mutation/policy events declare their result type:

```ts
interface ContextEvent extends HookEvent<"context", { messages?: AgentMessage[] }> {
	type: "context";
	messages: AgentMessage[];
}

interface ToolCallEvent extends HookEvent<"tool_call", { block?: boolean; reason?: string }> {
	type: "tool_call";
	toolName: string;
	input: Record<string, unknown>;
}
```

There is no central result map and no event spec table. The event type itself defines the return type handlers may produce.

## Hook handlers and registration options

Handlers are plain functions. Provenance and cleanup live on the registration.

```ts
export type HookCleanup = () => void | Promise<void>;

export type HookHandler<TEvent, TContext> = (
	event: TEvent,
	context: TContext,
	signal?: AbortSignal,
) => ResultOf<TEvent> | void | Promise<ResultOf<TEvent> | void>;

export interface HookRegistrationOptions<TSource> {
	source?: TSource;
	cleanup?: HookCleanup;
}
```

Example:

```ts
hooks.on(
	"context",
	(event, context) => ({ messages: injectContext(event.messages, context) }),
	{
		source: extensionSource,
		cleanup: () => cache.dispose(),
	},
);
```

The cleanup runs once, either when the returned unregister function is called, or when `clear()` / `dispose()` clears the registration.

## Reducers

Result-producing events need reducers. Observational events do not.

```ts
type ResultfulEvent<TEvent> = TEvent extends HookEvent<string, infer TResult>
	? [TResult] extends [void]
		? never
		: TEvent
	: never;

type HookRegistration<TContext, TSource> = {
	handler: HookHandler<any, TContext>;
	source?: TSource;
	cleanup?: HookCleanup;
	disposed: boolean;
	order: number;
};

type Reducer<TEvent, TContext, TSource> = (
	event: TEvent,
	registrations: readonly HookRegistration<TContext, TSource>[],
	context: TContext,
	signal?: AbortSignal,
) => Promise<ResultOf<TEvent> | undefined>;

type Reducers<TEvent, TContext, TSource> = {
	[TType in ResultfulEvent<TEvent>["type"]]: Reducer<
		Extract<ResultfulEvent<TEvent>, { type: TType }>,
		TContext,
		TSource
	>;
};
```

Reducers encode hook semantics, for example:

- `context`: sequential transform; each handler sees current messages.
- `before_provider_request`: sequential patch/transform; each handler sees current request state.
- `before_provider_payload`: sequential payload transform.
- `before_agent_start`: chain `systemPrompt`; collect injected messages.
- `tool_call`: same mutable event/input visible to later handlers; first `{ block: true }` stops.
- `tool_result`: sequential patch accumulation; each handler sees current patched result.
- `message_end`: sequential message replacement; replacement must keep the original role.
- `session_before_*`: first `{ cancel: true }` stops; otherwise return the last meaningful result.

Base harness reducers are defined once:

```ts
const agentHarnessReducers = {
	context: reduceContext,
	before_provider_request: reduceBeforeProviderRequest,
	before_provider_payload: reduceBeforeProviderPayload,
	before_agent_start: reduceBeforeAgentStart,
	tool_call: reduceToolCall,
	tool_result: reduceToolResult,
	message_end: reduceMessageEnd,
	session_before_compact: reduceFirstCancelOrLast,
	session_before_tree: reduceFirstCancelOrLast,
} satisfies Reducers<AgentHarnessEvent, AgentHarnessContext, unknown>;
```

If `AgentHarnessEvent` gains a new result-producing event, TypeScript forces the reducer table to be updated.

## Single hooks implementation

The hooks implementation stores registrations and runs reducers.

```ts
class AgentHarnessHooks<
	TEvent extends HookEvent<string, unknown>,
	TContext,
	TSource = unknown,
> {
	context: TContext;

	constructor(
		context: TContext,
		extraReducers?: ExtraReducers<TEvent, AgentHarnessEvent, TContext, TSource>,
	) {
		this.context = context;
		this.reducers = {
			...agentHarnessReducers,
			...extraReducers,
		} as Reducers<TEvent, TContext, TSource>;
	}

	setContext(context: TContext): void {
		this.context = context;
	}

	on<TType extends TEvent["type"]>(
		type: TType,
		handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
		options?: HookRegistrationOptions<TSource>,
	): () => Promise<void> {
		// Store the registration and return unregister.
	}

	async emit<TEmittedEvent extends TEvent>(
		event: TEmittedEvent,
		signal?: AbortSignal,
	): Promise<ResultOf<TEmittedEvent> | undefined> {
		const registrations = this.getRegistrations(event.type);
		const reducer = this.reducers[event.type as keyof typeof this.reducers];

		if (reducer) {
			return reducer(event as never, registrations as never, this.context, signal) as Promise<
				ResultOf<TEmittedEvent> | undefined
			>;
		}

		for (const registration of registrations) {
			await registration.handler(event, this.context, signal);
		}

		return undefined;
	}

	async clear(): Promise<void> {
		// Remove all registrations and run remaining cleanups once in reverse registration order.
	}

	dispose(): Promise<void> {
		return this.clear();
	}
}
```

Public API:

```ts
hooks.on(...);
hooks.emit(...);
hooks.clear();
hooks.dispose();
```

There is no wildcard subscription and no separate observer API.

## App-specific events and reducers

Apps extend the event union.

Observational app events need no reducer:

```ts
interface SessionStartEvent extends HookEvent<"session_start"> {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
}
```

Result-producing app events need an extra reducer:

```ts
type InputResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

interface InputEvent extends HookEvent<"input", InputResult> {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: "interactive" | "rpc" | "extension";
}
```

```ts
const codingAgentExtraReducers = {
	input: reduceInput,
	user_bash: reduceFirstResult,
	resources_discover: reduceResourcesDiscover,
	session_before_switch: reduceFirstCancelOrLast,
	session_before_fork: reduceFirstCancelOrLast,
} satisfies ExtraReducers<CodingAgentEvent, AgentHarnessEvent, CodingAgentContext, AppSource>;
```

Base reducers are included by the hooks constructor. Apps only provide reducers for app-specific result-producing events.

```ts
type CodingAgentEvent =
	| AgentHarnessEvent<AppSkill, AppPromptTemplate, AppTool>
	| SessionStartEvent
	| SessionShutdownEvent
	| InputEvent
	| UserBashEvent
	| ResourcesDiscoverEvent;

const hooks = new AgentHarnessHooks<CodingAgentEvent, CodingAgentContext, AppSource>(
	context,
	codingAgentExtraReducers,
);
```

## Harness typing

`AgentHarness` stores and exposes the concrete hooks object.

```ts
type DefaultHooks<TSkill, TPromptTemplate, TTool> = AgentHarnessHooks<
	AgentHarnessEvent<TSkill, TPromptTemplate, TTool>,
	undefined,
	unknown
>;

class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
	THooks = DefaultHooks<TSkill, TPromptTemplate, TTool>,
> {
	readonly hooks: THooks;

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool, THooks>) {
		this.hooks = options.hooks ?? createDefaultHooks();
	}
}
```

When custom hooks are passed, TypeScript infers `THooks` from `options.hooks`.

```ts
const hooks = new CodingAgentHooks(context, codingAgentExtraReducers);

const harness = new AgentHarness({
	model,
	session,
	hooks,
	resources,
	tools,
});

harness.hooks; // CodingAgentHooks
```

Custom app APIs live on `harness.hooks`; they are not proxied onto `AgentHarness`.

## Harness usage

The harness only emits events and uses typed results.

```ts
await this.hooks.emit({ type: "message_start", message }, signal);
```

```ts
const result = await this.hooks.emit({ type: "context", messages }, signal);
messages = result?.messages ?? messages;
```

```ts
const result = await this.hooks.emit({ type: "tool_call", toolName, input }, signal);
if (result?.block) return blockedToolResult(result.reason);
```

`AgentHarness` does not store handlers and does not implement hook chaining semantics.

## Context model

Context is a plain object owned by the hooks implementation.

```ts
hooks.setContext(nextContext);
```

Per-run `AbortSignal` is passed separately to `emit()` and handlers.

Dynamic app state should be exposed through small facades instead of late-bound getter mazes.

Example app context:

```ts
interface CodingAgentContext {
	harness: HarnessFacade;
	session: SessionFacade;
	ui: UiFacade;
	models: ModelFacade;
}
```

The hook context should not expose `waitForIdle()` to hook handlers. A future facade can expose `runWhenIdle(() => Promise<void>)` for safe deferred work.

## Cleanup semantics

Each registration owns at most one cleanup.

- Manual unregister removes the registration and runs its cleanup once.
- `clear()` removes all remaining registrations and runs their cleanups once.
- `dispose()` calls `clear()`.
- Cleanup order is reverse registration order.
- Cleanup errors are collected; cleanup continues; `clear()` throws an aggregate error if any cleanup failed.

## Error policy

The base hooks implementation can throw handler errors by default.

App-specific hooks that load untrusted/user extensions should use a continue-and-report policy. Reducers receive registration source metadata so they can report errors with provenance:

```ts
for (const registration of registrations) {
	try {
		const result = await registration.handler(event, context, signal);
		// apply result
	} catch (error) {
		reportHookError({
			event: event.type,
			source: registration.source,
			error,
		});
	}
}
```

## Extension loading sketch

An app-level extension host owns extension loading and non-hook registries. The harness only receives hooks.

```ts
class ExtensionHost {
	constructor(private readonly hooks: AgentHarnessHooks<CodingAgentEvent, CodingAgentContext, AppSource>) {}

	async load(paths: string[]): Promise<void> {
		for (const path of paths) {
			const extension = await loadExtension(path);
			const source = createExtensionSource(path);

			const api = {
				on: (type, handler, cleanup) => {
					this.hooks.on(type, handler, { source, cleanup });
				},
				registerTool: (tool) => {
					this.tools.set(tool.name, { ...tool, source });
				},
			};

			await extension(api);
		}
	}

	async clear(): Promise<void> {
		this.tools.clear();
		this.commands.clear();
		await this.hooks.clear();
	}
}
```

Non-hook registries, such as tools, commands, flags, shortcuts, message renderers, providers, and OAuth providers, remain app-level concerns.
