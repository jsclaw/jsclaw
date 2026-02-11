/**
 * Shared IPC file utilities. Atomic write/read/drain for JSON IPC.
 * @module ipc-utils
 */

import { writeFileSync, readFileSync, renameSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Atomically write a JSON IPC file (write .tmp, then rename).
 * @param {string} dir - Target directory
 * @param {Object} data - Data to serialize as JSON
 * @param {string} [prefix] - Optional filename prefix
 * @returns {string} The final file path
 */
export function writeIpcFile(dir, data, prefix = '') {
  mkdirSync(dir, { recursive: true });
  const filename = `${prefix}${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const tmpPath = join(dir, `.${filename}.tmp`);
  const finalPath = join(dir, filename);
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * Read and parse a JSON IPC file.
 * @param {string} filePath - Path to the JSON file
 * @returns {Object|null} Parsed data, or null on failure
 */
export function readIpcFile(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read all .json files from a directory, parse them, delete originals.
 * @param {string} dir - Directory to drain
 * @param {(name: string) => boolean} [filter] - Optional filename filter
 * @returns {Array<{ data: Object, filename: string }>} Parsed entries
 */
export function drainIpcDir(dir, filter) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('.')) continue; // skip temp files
    if (filter && !filter(name)) continue;

    const filePath = join(dir, name);
    const data = readIpcFile(filePath);
    if (data !== null) {
      results.push({ data, filename: name });
      try {
        unlinkSync(filePath);
      } catch {
        // best effort cleanup
      }
    }
  }
  return results;
}

/**
 * Write a close sentinel file to signal a container to exit.
 * @param {string} dir - IPC input directory
 */
export function writeCloseSentinel(dir) {
  mkdirSync(dir, { recursive: true });
  const closePath = join(dir, '_close');
  writeFileSync(closePath, '');
}
