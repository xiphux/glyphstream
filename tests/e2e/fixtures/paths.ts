import { resolve } from 'node:path';

/** JSONL of server-side errors written by capture-server-errors.mjs, read per
 *  test by fixtures/test.ts. Its own module so playwright.config.ts can import
 *  the path without loading the test fixtures. */
export const SERVER_ERRORS_LOG = resolve('./tests/.e2e-data/server-errors.jsonl');
