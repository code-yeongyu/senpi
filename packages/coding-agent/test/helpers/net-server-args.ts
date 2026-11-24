/**
 * The two call forms of `net.createServer`, for the fixtures that replace it to observe a supervisor's connections:
 * `(accept)` and `(options, accept)`. The supervisor's public proxy passes options (`allowHalfOpen`) since
 * oh-my-openagent#14725, and a replacement that kept only the first form called the options object.
 */
import type { ServerOpts, Socket } from "node:net";

type Accept = (socket: Socket) => void;

export function createServerArgs(first: ServerOpts | Accept, second?: Accept): { options: ServerOpts; accept: Accept } {
	if (typeof first === "function") return { options: {}, accept: first };
	if (second === undefined) throw new Error("createServer needs an accept callback");
	return { options: first, accept: second };
}
