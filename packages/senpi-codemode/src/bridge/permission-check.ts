import type { CellDecision, CellOperation } from "../kernels/js/permission-slots.mjs";

const checks = new Map<string, (call: CellOperation) => Promise<CellDecision>>();

/** Only the host registers invocation capabilities. The ordinary bridge bearer is not one. */
export function registerPermissionCheck(
	token: string,
	check: (call: CellOperation) => Promise<CellDecision>,
): () => void {
	checks.set(token, check);
	return () => checks.delete(token);
}

export async function permissionCheck(body: unknown): Promise<unknown> {
	if (
		typeof body !== "object" ||
		body === null ||
		!("token" in body) ||
		typeof body.token !== "string" ||
		!("nonce" in body) ||
		typeof body.nonce !== "string" ||
		!("call" in body)
	) {
		throw new Error("Invalid permission request");
	}
	const call = body.call;
	if (
		typeof call !== "object" ||
		call === null ||
		!("tool" in call) ||
		!("input" in call) ||
		typeof call.input !== "object" ||
		call.input === null
	)
		throw new Error("Invalid permission operation");
	if (call.tool !== "bash" && call.tool !== "write" && call.tool !== "read" && call.tool !== "ls")
		throw new Error("Invalid permission tool");
	const input = call.input;
	if (
		call.tool === "bash"
			? !("command" in input && typeof input.command === "string")
			: !("path" in input && typeof input.path === "string")
	)
		throw new Error("Invalid permission input");
	if ("cwd" in call && typeof call.cwd !== "string") throw new Error("Invalid execution cwd");
	const check = checks.get(body.token);
	if (!check) throw new Error("Permission authority unavailable");
	const canonical = "canonical" in input ? input.canonical : undefined;
	const validCanonical =
		typeof canonical === "object" &&
		canonical !== null &&
		"v" in canonical &&
		typeof canonical.v === "number" &&
		"path" in canonical &&
		typeof canonical.path === "string" &&
		"foldCase" in canonical &&
		typeof canonical.foldCase === "boolean"
			? { v: canonical.v, path: canonical.path, foldCase: canonical.foldCase }
			: undefined;
	const operation: CellOperation = {
		tool: call.tool,
		input: {
			...("command" in input && typeof input.command === "string" ? { command: input.command } : {}),
			...("path" in input && typeof input.path === "string" ? { path: input.path } : {}),
			...("executedPath" in input && typeof input.executedPath === "string"
				? { executedPath: input.executedPath }
				: {}),
			...(validCanonical === undefined ? {} : { canonical: validCanonical }),
			...("unresolvable" in input && typeof input.unresolvable === "string"
				? { unresolvable: input.unresolvable }
				: {}),
		},
		...("cwd" in call && typeof call.cwd === "string" ? { cwd: call.cwd } : {}),
	};
	return { nonce: body.nonce, decision: await check(operation) };
}
