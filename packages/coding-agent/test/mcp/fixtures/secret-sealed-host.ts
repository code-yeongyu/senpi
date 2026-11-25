import { SecretInputRequests } from "../../../src/modes/rpc/secret-input-requests.ts";
import { accountHost, enrollAssignAcquire, installation, issuer, type AccountHost } from "./presenter-account-host.ts";
import { secretHostIssuer } from "./secret-host-issuer.ts";

/** A host whose account authority can mint host tokens and verify step-up tokens, plus its in-process secret latch. */

export const SECRET = ["secret_input_v1"];
export const nowS = () => Math.floor(Date.now() / 1000);

export type Line = Record<string, unknown>;
export const records = (lines: readonly string[], type: string): Line[] =>
	lines.map((line) => JSON.parse(line) as Line).filter((record) => record.type === type);
export const sealedTypes = (lines: readonly string[]) =>
	lines
		.map((line) => String((JSON.parse(line) as Line).type))
		.filter((type) => type.startsWith("mcp_presenter_secret"));

export async function sealedHost(options: { lifetimeS?: number } = {}) {
	const secret = secretHostIssuer(issuer, options.lifetimeS);
	const host = await accountHost({ account: secret.authority });
	const requests = new SecretInputRequests(host.writer.secretInputRoute("session", true), () => {});
	return { host, secret, requests };
}

/** A same-account device on its own RPC connection, holding a grant with `features`. */
export async function holder(
	host: AccountHost,
	secret: ReturnType<typeof secretHostIssuer>,
	id: string,
	features = SECRET,
) {
	const device = host.presenter(id);
	const adopted = await enrollAssignAcquire(host, installation(), {
		context: device.context,
		claims: { dev: `device-${id}`, exp: nowS() + 900 },
		features,
	});
	if (adopted.acquired?.type !== "mcp_presenter_acquired") throw new Error("The holder's acquire was refused");
	await secret.mints.at(-1)?.done;
	return { ...device, adopted };
}
