export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.MORGAN_EXPERIMENTAL === "1";
}
