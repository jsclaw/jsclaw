/**
 * Volume mount validation against an allowlist.
 * Prevents containers from accessing sensitive host paths.
 * @module mount-security
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, normalize } from 'node:path';

const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.env',
  'private_key',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'secrets',
  '.npmrc',
  '.pypirc',
];

/**
 * Load and validate a mount allowlist from a JSON file.
 * @param {string} allowlistPath - Path to allowlist JSON
 * @returns {import('./types.js').MountAllowlist|null}
 */
export function loadMountAllowlist(allowlistPath) {
  try {
    const raw = readFileSync(allowlistPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.allowed_roots || !Array.isArray(parsed.allowed_roots)) {
      return null;
    }
    return {
      allowed_roots: parsed.allowed_roots.map((r) => resolve(r)),
      blocked_patterns: parsed.blocked_patterns || [],
    };
  } catch {
    return null;
  }
}

/**
 * Check if a path matches any blocked pattern.
 * @param {string} hostPath
 * @param {string[]} extraBlocked
 * @returns {string|null} The matched pattern, or null if safe
 */
function matchesBlocked(hostPath, extraBlocked = []) {
  const allBlocked = [...DEFAULT_BLOCKED_PATTERNS, ...extraBlocked];
  const normalized = normalize(hostPath).toLowerCase();
  for (const pattern of allBlocked) {
    if (normalized.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

/**
 * Validate a single mount against the allowlist.
 * @param {import('./types.js').AdditionalMount} mount
 * @param {boolean} isMain - Whether this is the main/admin group
 * @param {import('./types.js').MountAllowlist} allowlist
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateMount(mount, isMain, allowlist) {
  const { host_path, container_path } = mount;

  // Container path must not escape
  if (container_path.includes('..') || !container_path.startsWith('/')) {
    return { valid: false, reason: `Invalid container path: ${container_path}` };
  }

  // Resolve symlinks
  let realHostPath;
  try {
    realHostPath = realpathSync(host_path);
  } catch {
    return { valid: false, reason: `Host path does not exist: ${host_path}` };
  }

  // Check blocked patterns
  const blocked = matchesBlocked(realHostPath, allowlist.blocked_patterns);
  if (blocked) {
    return { valid: false, reason: `Path matches blocked pattern '${blocked}': ${realHostPath}` };
  }

  // Check allowed roots
  const underAllowedRoot = allowlist.allowed_roots.some(
    (root) => realHostPath === root || realHostPath.startsWith(root + '/')
  );
  if (!underAllowedRoot) {
    return {
      valid: false,
      reason: `Path not under any allowed root: ${realHostPath}`,
    };
  }

  return { valid: true };
}

/**
 * Validate an array of additional mounts.
 * @param {import('./types.js').AdditionalMount[]} mounts
 * @param {string} groupName
 * @param {boolean} isMain
 * @param {string} [allowlistPath]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAdditionalMounts(mounts, groupName, isMain, allowlistPath) {
  if (!mounts || mounts.length === 0) {
    return { valid: true, errors: [] };
  }

  if (!allowlistPath) {
    return {
      valid: false,
      errors: ['No mount allowlist configured. All additional mounts are blocked.'],
    };
  }

  const allowlist = loadMountAllowlist(allowlistPath);
  if (!allowlist) {
    return {
      valid: false,
      errors: [`Failed to load mount allowlist from: ${allowlistPath}`],
    };
  }

  const errors = [];
  for (const mount of mounts) {
    const result = validateMount(mount, isMain, allowlist);
    if (!result.valid) {
      errors.push(result.reason);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate a template allowlist JSON.
 * @returns {Object}
 */
export function generateAllowlistTemplate() {
  return {
    allowed_roots: ['/home', '/opt/data'],
    blocked_patterns: [],
    _comment: 'Add host directories that containers may mount. Default blocked patterns always apply.',
  };
}
