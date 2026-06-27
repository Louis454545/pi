export function getMorganUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `morgan/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
