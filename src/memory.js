/**
 * Markdown memory — openclaw's convention, per group.
 *
 * Memory lives in {groupsDir}/{folder}/memory/ as plain Markdown files
 * (preferences.md, contacts.md, projects.md, learnings.md + custom).
 * Because the group folder is already mounted into the container, the
 * agent reads and writes its own memory with ordinary fs tools; the
 * agent runner loads it into the system prompt at startup.
 * @module memory
 */

import {
  readFileSync, writeFileSync, appendFileSync, readdirSync,
  mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { createConfig } from './config.js';

/** openclaw's default memory categories. */
export const MEMORY_CATEGORIES = ['preferences', 'contacts', 'projects', 'learnings'];

/**
 * Path to a group's memory directory.
 * @param {string} groupFolder
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {string}
 */
export function memoryDir(groupFolder, config) {
  config = config || createConfig();
  return join(config.groupsDir, groupFolder, 'memory');
}

/**
 * Create the memory directory with seeded category files.
 * Existing files are left untouched.
 * @param {string} groupFolder
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {string} The memory directory path
 */
export function initMemory(groupFolder, config) {
  const dir = memoryDir(groupFolder, config);
  mkdirSync(dir, { recursive: true });
  for (const category of MEMORY_CATEGORIES) {
    const file = join(dir, `${category}.md`);
    if (!existsSync(file)) {
      const title = category[0].toUpperCase() + category.slice(1);
      writeFileSync(file, `# ${title}\n`);
    }
  }
  return dir;
}

/**
 * List a group's memory files.
 * @param {string} groupFolder
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {{ name: string, path: string, size: number }[]}
 */
export function listMemoryFiles(groupFolder, config) {
  const dir = memoryDir(groupFolder, config);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const path = join(dir, e.name);
      let size = 0;
      try {
        size = readFileSync(path, 'utf-8').length;
      } catch {
        // unreadable file counts as empty
      }
      return { name: e.name, path, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a group's memory as one string for the system prompt,
 * truncated to a character budget (most files survive truncation
 * in listing order; a file that would overflow is cut with a marker).
 * @param {string} groupFolder
 * @param {import('./types.js').JsclawConfig} [config]
 * @param {{ maxChars?: number }} [opts] - Default 8000 chars (~2k tokens)
 * @returns {string} Concatenated memory, or '' if none
 */
export function loadMemoryContext(groupFolder, config, opts = {}) {
  const { maxChars = 8000 } = opts;
  const files = listMemoryFiles(groupFolder, config);
  const parts = [];
  let used = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file.path, 'utf-8').trim();
    } catch {
      continue;
    }
    // Skip files that are empty or only a seeded heading
    if (!content || /^#[^\n]*$/.test(content)) continue;

    const section = `## ${file.name}\n${content}`;
    if (used + section.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > 100) {
        parts.push(section.slice(0, remaining) + '\n[...memory truncated]');
      }
      break;
    }
    parts.push(section);
    used += section.length + 2;
  }

  return parts.length > 0 ? `# Memory\n\n${parts.join('\n\n')}` : '';
}

/**
 * Append a fact to a memory category file.
 * @param {string} groupFolder
 * @param {string} category - Category name ('preferences') or filename ('recipes.md')
 * @param {string} text - The fact to record
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {string} Path of the file written
 */
export function appendMemory(groupFolder, category, text, config) {
  const dir = memoryDir(groupFolder, config);
  mkdirSync(dir, { recursive: true });
  const name = category.endsWith('.md') ? category : `${category}.md`;
  // basename() prevents path traversal out of the memory dir
  const file = join(dir, basename(name));
  appendFileSync(file, `- ${text.trim()}\n`);
  return file;
}

/**
 * Case-insensitive line search across a group's memory.
 * @param {string} groupFolder
 * @param {string} query
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function searchMemory(groupFolder, query, config) {
  const needle = query.toLowerCase();
  const results = [];
  for (const file of listMemoryFiles(groupFolder, config)) {
    let content;
    try {
      content = readFileSync(file.path, 'utf-8');
    } catch {
      continue;
    }
    content.split('\n').forEach((text, i) => {
      if (text.toLowerCase().includes(needle)) {
        results.push({ file: file.name, line: i + 1, text: text.trim() });
      }
    });
  }
  return results;
}

/**
 * Delete a group's memory directory.
 * @param {string} groupFolder
 * @param {import('./types.js').JsclawConfig} [config]
 */
export function clearMemory(groupFolder, config) {
  rmSync(memoryDir(groupFolder, config), { recursive: true, force: true });
}
