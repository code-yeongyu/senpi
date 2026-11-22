export interface IdealCompactionSettings {
	graceBandEnabled?: boolean;
	toolAdmissionEnabled?: boolean;
	reserveScalingEnabled?: boolean;
	speculativeLeadTokens?: number;
}

export const DEFAULT_IDEAL_COMPACTION_SETTINGS: Required<Omit<IdealCompactionSettings, "speculativeLeadTokens">> = {
	graceBandEnabled: true,
	toolAdmissionEnabled: true,
	reserveScalingEnabled: true,
};
