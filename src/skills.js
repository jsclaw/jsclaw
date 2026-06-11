/**
 * Skills — reusable agent capabilities in openclaw's SKILL.md format:
 * YAML frontmatter (name, description, trigger, tools, ...) followed by
 * a Markdown instruction body. Triggered skills are injected into the
 * agent's prompt. Zero dependencies, including the frontmatter parser.
 * @module skills
 */

import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createConfig } from './config.js';

/**
 * @typedef {Object} Skill
 * @property {string} name - Unique slug from frontmatter
 * @property {string} description
 * @property {string} [version]
 * @property {string} trigger - Keywords ('deploy|ship'), '/regex/i', 'attachment:<type>', or '*'
 * @property {string[]} [tools] - Tools the skill declares it needs
 * @property {Object} [config] - User-configurable settings
 * @property {string} body - Markdown instructions
 * @property {string} [path] - Source file path
 */

// --- Minimal YAML subset parser (enough for SKILL.md frontmatter) ---

/**
 * Parse a scalar YAML value: quoted/bare strings, numbers, booleans,
 * inline arrays.
 * @param {string} raw
 * @returns {*}
 */
function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => parseScalar(x));
  }
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^\d+\.\d+\.\d+/.test(raw.trim())) {
    return Number(s);
  }
  return s;
}

/**
 * Parse a YAML-subset block into an object. Supports scalars,
 * inline arrays, block lists (- item), and nested maps by indentation.
 * @param {string[]} lines
 * @param {number} indent - Current indentation level
 * @returns {[Object, number]} Parsed object and lines consumed
 */
function parseBlock(lines, indent) {
  const obj = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      // Should have been consumed by a nested parse; skip defensively
      i++;
      continue;
    }

    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest !== '') {
      obj[key] = parseScalar(rest);
      i++;
      continue;
    }

    // Empty value: nested map or block list follows
    const nested = [];
    let j = i + 1;
    while (j < lines.length) {
      const nline = lines[j];
      if (nline.trim() === '' || nline.trim().startsWith('#')) {
        nested.push(nline);
        j++;
        continue;
      }
      const nindent = nline.length - nline.trimStart().length;
      if (nindent <= indent) break;
      nested.push(nline);
      j++;
    }

    const items = nested.filter((l) => l.trim());
    if (items.length > 0 && items.every((l) => l.trim().startsWith('- '))) {
      obj[key] = items.map((l) => parseScalar(l.trim().slice(2)));
    } else if (items.length > 0) {
      const childIndent = items[0].length - items[0].trimStart().length;
      const [child] = parseBlock(nested, childIndent);
      obj[key] = child;
    } else {
      obj[key] = null;
    }
    i = j;
  }

  return [obj, i];
}

/**
 * Split a document into YAML frontmatter and body.
 * @param {string} content
 * @returns {{ data: Object, body: string }}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  const [data] = parseBlock(match[1].split('\n'), 0);
  return { data, body: match[2].trim() };
}

// --- Skill loading ---

/**
 * Parse a SKILL.md document into a Skill.
 * @param {string} content
 * @param {string} [path] - Source path for error messages
 * @returns {Skill}
 * @throws {Error} if required fields are missing
 */
export function parseSkill(content, path) {
  const { data, body } = parseFrontmatter(content);
  if (!data.name) throw new Error(`Skill missing 'name' in frontmatter${path ? `: ${path}` : ''}`);
  if (!data.description) throw new Error(`Skill missing 'description': ${data.name}`);

  return {
    name: String(data.name),
    description: String(data.description),
    version: data.version != null ? String(data.version) : undefined,
    trigger: data.trigger != null ? String(data.trigger) : '*',
    tools: Array.isArray(data.tools) ? data.tools.map(String) : undefined,
    config: typeof data.config === 'object' && data.config ? data.config : undefined,
    body,
    path,
  };
}

/**
 * Load all skills from the skills directory.
 * Invalid skill files are skipped with a warning.
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {Skill[]}
 */
export function loadSkills(config) {
  config = config || createConfig();
  const log = config.logger;
  let entries;
  try {
    entries = readdirSync(config.skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    // Flat <name>.md files, or folder skills (<name>/SKILL.md + resources)
    // — the openclaw/Anthropic layout; nearly all real skills are folders.
    let path = null;
    if (entry.isDirectory()) {
      const candidate = join(config.skillsDir, entry.name, 'SKILL.md');
      if (existsSync(candidate)) path = candidate;
    } else if (entry.name.endsWith('.md')) {
      path = join(config.skillsDir, entry.name);
    }
    if (!path) continue;
    try {
      skills.push(parseSkill(readFileSync(path, 'utf-8'), path));
    } catch (err) {
      log.warn(`Skipping invalid skill: ${entry.name}`, { error: err.message });
    }
  }
  return skills;
}

/**
 * Install a skill into the skills directory. Accepts a flat .md file, a
 * folder containing SKILL.md (resources are copied along), or a path to
 * the SKILL.md inside such a folder.
 * @param {string} sourcePath
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {Skill} The installed skill
 */
export function installSkill(sourcePath, config) {
  config = config || createConfig();

  let sourceDir = null;
  let skillFile = sourcePath;
  if (statSync(sourcePath).isDirectory()) {
    sourceDir = sourcePath;
    skillFile = join(sourcePath, 'SKILL.md');
  } else if (basename(sourcePath) === 'SKILL.md') {
    sourceDir = dirname(sourcePath);
  }

  const skill = parseSkill(readFileSync(skillFile, 'utf-8'), skillFile);
  mkdirSync(config.skillsDir, { recursive: true });

  if (sourceDir) {
    // Folder skill: copy the whole folder so relative resources survive
    const dest = join(config.skillsDir, basename(skill.name));
    cpSync(sourceDir, dest, { recursive: true });
    return { ...skill, path: join(dest, 'SKILL.md') };
  }
  const dest = join(config.skillsDir, `${basename(skill.name)}.md`);
  writeFileSync(dest, readFileSync(skillFile, 'utf-8'));
  return { ...skill, path: dest };
}

/**
 * Remove an installed skill by name.
 * @param {string} name
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {boolean} Whether the skill existed
 */
export function removeSkill(name, config) {
  config = config || createConfig();
  const flat = join(config.skillsDir, `${basename(name)}.md`);
  if (existsSync(flat)) {
    unlinkSync(flat);
    return true;
  }
  const folder = join(config.skillsDir, basename(name));
  if (existsSync(join(folder, 'SKILL.md'))) {
    rmSync(folder, { recursive: true });
    return true;
  }
  return false;
}

// --- Trigger matching ---

/**
 * Check whether a message triggers a skill.
 * @param {Skill} skill
 * @param {{ text?: string, attachments?: Array<{type: string}> }} message
 * @returns {boolean}
 */
export function skillMatches(skill, message) {
  const trigger = skill.trigger;
  if (trigger === '*') return true;

  // attachment:<type>
  if (trigger.startsWith('attachment:')) {
    const wanted = trigger.slice('attachment:'.length);
    return (message.attachments || []).some((a) => a.type === wanted);
  }

  const text = message.text || '';

  // /regex/flags
  const regexMatch = trigger.match(/^\/(.+)\/([a-z]*)$/s);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]).test(text);
    } catch {
      return false;
    }
  }

  // Pipe-separated keywords, case-insensitive
  const lower = text.toLowerCase();
  return trigger
    .split('|')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .some((k) => lower.includes(k));
}

/**
 * All skills triggered by a message.
 * @param {Skill[]} skills
 * @param {{ text?: string, attachments?: Array<{type: string}> }} message
 * @returns {Skill[]}
 */
export function matchSkills(skills, message) {
  return skills.filter((s) => skillMatches(s, message));
}

/**
 * Build the prompt section for triggered skills.
 * @param {Skill[]} skills
 * @returns {string} Prompt section, or '' if none
 */
export function buildSkillContext(skills) {
  if (skills.length === 0) return '';
  const sections = skills.map((s) => `## Skill: ${s.name}\n${s.body}`);
  return `# Active Skills\n\nThe following skill instructions apply to this message:\n\n${sections.join('\n\n')}`;
}
