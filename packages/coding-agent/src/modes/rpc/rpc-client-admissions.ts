import { RecoveryRepairController } from "@earendil-works/pi-client";
import { z } from "zod";
import { RpcCommandError } from "./rpc-command-error.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

export type RpcOpenOptions = Omit<Extract<RpcCommand, { type: "open_session" }>, "type" | "id">;
export type LegacyOpenResult = Extract<RpcResponse, { command: "open_session"; success: true }>["data"];
const routeSchema = z.object({
	sessionId: z.string(),
	admissionId: z.string(),
	generation: z.number().int().nonnegative(),
	token: z.string().optional(),
});
const answerSchema = routeSchema.extend({
	data: z.object({ recovery: z.object({ token: z.string(), componentRef: z.string() }) }),
});
export type CompactOpenResult = z.infer<typeof routeSchema> & {
	readonly recovery: { readonly token: string; readonly componentRef: string };
};
type Route = {
	readonly repair: RecoveryRepairController;
	sessionId?: string;
	token?: string;
	generation: number;
	notBefore: number;
};
type Send = (command: RpcCommand) => Promise<RpcResponse>;

/** Pre-send admission routes and event-driven repair. No prompt, mutable-root fallback, timer or retry loop. */
export class RpcClientAdmissions {
	private readonly routes = new Map<string, Route>();
	private readonly send: Send;
	private serial = 0;

	constructor(send: Send) {
		this.send = send;
	}

	clear(): void {
		this.routes.clear();
	}

	receive(input: unknown): void {
		if (this.routes.size === 0) return;
		const parsed = routeSchema.safeParse(input);
		if (!parsed.success) return;
		const frame = parsed.data;
		const route = this.routes.get(frame.admissionId);
		if (!route || frame.generation < route.generation) return;
		route.sessionId = frame.sessionId;
		route.generation = frame.generation;
		if (frame.token !== undefined) route.token = frame.token;
	}

	private accept(response: RpcResponse): CompactOpenResult {
		if (!response.success) throw new RpcCommandError(response.error, response.errorCode, response.errorData);
		const parsed = answerSchema.parse(response);
		this.receive({ ...parsed, token: parsed.data.recovery.token });
		const current = this.routes.get(parsed.admissionId);
		return {
			sessionId: current?.sessionId ?? parsed.sessionId,
			admissionId: parsed.admissionId,
			generation: current?.generation ?? parsed.generation,
			recovery: { ...parsed.data.recovery, token: current?.token ?? parsed.data.recovery.token },
		};
	}

	async open(options: RpcOpenOptions & { admissionId: string }): Promise<CompactOpenResult> {
		const existing = this.routes.has(options.admissionId);
		if (!existing)
			this.routes.set(options.admissionId, { repair: new RecoveryRepairController(), generation: 0, notBefore: 0 });
		try {
			const opened = this.accept(await this.send({ ...options, type: "open_session" }));
			// open returns routing identity, not page content. page retains wait/backoff state;
			// a catalog restart replaces that identity before the caller can use it.
			const manifest = await this.page(options.admissionId, "manifest");
			return manifest.action === "restart_from_catalog" ? manifest.identity : opened;
		} catch (cause) {
			if (!existing) this.routes.delete(options.admissionId);
			throw cause;
		}
	}

	async page(admissionId: string, componentRef: string, cursor?: string) {
		const route = this.routes.get(admissionId);
		if (!route?.token || !route.sessionId)
			throw new RpcCommandError("unknown compact admission", "unknown_admission", undefined);
		const now = Date.now();
		if (now < route.notBefore) return { action: "wait", retryAfterMs: route.notBefore - now } as const;
		const token = route.token;
		const response = await this.send({
			type: "get_recovery_page",
			sessionId: route.sessionId,
			admissionId,
			token,
			componentRef,
			requestId: `page-${++this.serial}`,
			...(cursor === undefined ? {} : { cursor }),
		});
		const parsed = z
			.object({ repair: z.unknown(), reason: z.string().optional() })
			.safeParse(response.success ? ("data" in response ? response.data : undefined) : response.errorData);
		if (!parsed.success) {
			if (!response.success) throw new RpcCommandError(response.error, response.errorCode, response.errorData);
			throw parsed.error;
		}
		const body = parsed.data;
		const received = Date.now();
		const action = route.repair.observe(body.repair, received, { token, reason: body.reason ?? "" });
		switch (action.action) {
			case "ready":
				return { action: "ready", response } as const;
			case "wait":
				route.notBefore = received + action.retryAfterMs;
				return action;
			case "restart_from_catalog": {
				const reset = await this.send({ type: "reset_stream", sessionId: route.sessionId, admissionId });
				const identity = this.accept(reset);
				return { action: "restart_from_catalog", response: reset, identity } as const;
			}
		}
	}
}
