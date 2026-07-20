export type AuthGatewayStatus = {
	readonly brokerConfigured: boolean;
	readonly credentialCount: number;
	readonly gatewayTokenPresent: boolean;
	readonly ready: boolean;
};

export function formatGatewayStatus(
	json: boolean,
	status: AuthGatewayStatus,
): { readonly exitCode: number; readonly stderr: ""; readonly stdout: string } {
	if (json) return { exitCode: status.ready ? 0 : 1, stderr: "", stdout: `${JSON.stringify(status)}\n` };
	const output = `broker: ${status.brokerConfigured ? "configured" : "missing"}\ncredentials: ${status.credentialCount}\ngateway token: ${status.gatewayTokenPresent ? "present" : "missing"}\n`;
	return { exitCode: status.ready ? 0 : 1, stderr: "", stdout: output };
}
