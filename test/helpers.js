/** Shared test helpers. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../src/config.js';

export const nullLogger = {
  debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/**
 * A config rooted in a fresh temp directory.
 * @param {Object} [overrides]
 */
export function tempConfig(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jsclaw-test-'));
  return createConfig({
    dataDir: join(root, 'data'),
    agentsDir: join(root, 'agents'),
    skillsDir: join(root, 'skills'),
    configPath: join(root, 'jsclaw.json'), // avoid picking up a real ./jsclaw.json
    logger: nullLogger,
    ...overrides,
  });
}
