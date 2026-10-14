/**
 * The server logger: a `[scope]` prefix on the output the hand-written
 * `console.*('[scope] …')` calls produced, filtered by LOG_LEVEL.
 */
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '#lib/server/log.js';

const original = process.env.LOG_LEVEL;
afterEach(() => {
	if (original === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = original;
	vi.restoreAllMocks();
});

function spies() {
	return {
		debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
		info: vi.spyOn(console, 'info').mockImplementation(() => {}),
		warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
		error: vi.spyOn(console, 'error').mockImplementation(() => {}),
	};
}

describe('createLogger', () => {
	it('prefixes the message and passes further arguments through untouched', () => {
		const c = spies();
		const err = new Error('boom');
		createLogger('thumbnail').warn('generation failed for a.png:', err);
		expect(c.warn).toHaveBeenCalledWith('[thumbnail] generation failed for a.png:', err);
	});

	it('prints the bare prefix for an empty message', () => {
		const c = spies();
		createLogger('push').error('', 'detail');
		expect(c.error).toHaveBeenCalledWith('[push]', 'detail');
	});

	it('defaults to info: debug is dropped, the rest print to their own console method', () => {
		delete process.env.LOG_LEVEL;
		const c = spies();
		const log = createLogger('x');
		log.debug('d');
		log.info('i');
		log.warn('w');
		log.error('e');
		expect(c.debug).not.toHaveBeenCalled();
		expect(c.info).toHaveBeenCalledWith('[x] i');
		expect(c.warn).toHaveBeenCalledWith('[x] w');
		expect(c.error).toHaveBeenCalledWith('[x] e');
		expect(log.enabled('debug')).toBe(false);
	});

	it('prints debug lines at LOG_LEVEL=debug, read at call time', () => {
		const c = spies();
		const log = createLogger('x');
		process.env.LOG_LEVEL = 'DEBUG';
		log.debug('now visible');
		expect(c.debug).toHaveBeenCalledWith('[x] now visible');
		expect(log.enabled('debug')).toBe(true);
	});

	it('quiets everything below the configured level', () => {
		process.env.LOG_LEVEL = 'error';
		const c = spies();
		const log = createLogger('x');
		log.info('i');
		log.warn('w');
		log.error('e');
		expect(c.info).not.toHaveBeenCalled();
		expect(c.warn).not.toHaveBeenCalled();
		expect(c.error).toHaveBeenCalledOnce();
	});

	it('reads an unrecognised LOG_LEVEL as info', () => {
		process.env.LOG_LEVEL = 'verbose';
		const c = spies();
		const log = createLogger('x');
		log.debug('d');
		log.info('i');
		expect(c.debug).not.toHaveBeenCalled();
		expect(c.info).toHaveBeenCalledOnce();
	});
});
