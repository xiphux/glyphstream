function readString(name: string, fallback: string): string {
	return process.env[name] ?? fallback;
}

function readInt(name: string, fallback: number): number {
	const v = process.env[name];
	return v ? Number.parseInt(v, 10) : fallback;
}

export function dbPath(): string {
	return readString('DB_PATH', './data/glyphstream.db');
}

export function mediaDir(): string {
	return readString('MEDIA_DIR', './data/media');
}

export function mediaGracePeriodDays(): number {
	return readInt('MEDIA_GRACE_PERIOD_DAYS', 7);
}

export function mediaPurgeIntervalSeconds(): number {
	return readInt('MEDIA_PURGE_INTERVAL_SECONDS', 3600);
}

export function configPath(): string {
	return readString('CONFIG_PATH', './config.toml');
}

export function logLevel(): string {
	return readString('LOG_LEVEL', 'info');
}
