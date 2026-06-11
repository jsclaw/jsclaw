/**
 * jsclaw onboard — interactive setup wizard (openclaw parity).
 * Zero dependencies: node:readline/promises.
 *
 * Checks the environment, picks a provider/model (Anthropic, GLM, Kimi,
 * Bedrock, Vertex, or any Anthropic-compatible endpoint), scaffolds
 * agents/main with starter identity files, and writes jsclaw.json with
 * ${ENV_VAR} references — never literal secrets.
 *
 * The config-building logic is pure and exported for tests; only the
 * prompting shell is interactive.
 */

import { createInterface } from 'node:readline/promises';
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from '../src/providers.js';
import { initMemory } from '../src/memory.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SOUL_TEMPLATE = `# SOUL.md

You are the colleague who actually gets things done.

## Core truths
- **Results over process** — don't explain what you'll do, do it.
- **Ownership** — you own tasks end-to-end.

## Boundaries
- Skip "Great question!" and filler — just help.
- If you change this file, say so.

## Continuity
- Each session starts fresh; these files are your memory.
- Record important facts in memory/ so they persist.
`;

export const HEARTBEAT_TEMPLATE = `# HEARTBEAT.md

<!-- Standing orders, checked on every heartbeat cycle.
     Keep this small: every line costs tokens on every cycle.
     Reply HEARTBEAT_OK when nothing needs attention. -->

## Every heartbeat
<!-- - Check X, alert me if Y -->

## Daily (morning)
<!-- - Summarize my calendar in three lines -->
`;

/**
 * Pure config builder — answers in, jsclaw.json patch + env guidance out.
 *
 * @param {{ provider: string, keyEnvVar?: string, baseUrl?: string,
 *           model?: string, heartbeatModel?: string, gatewayToken?: string }} answers
 * @returns {{ config: Object, envExports: string[], notes: string[] }}
 */
export function buildOnboardConfig(answers) {
  const preset = PROVIDERS[answers.provider];
  if (!preset) throw new Error(`unknown provider: ${answers.provider}`);

  const keyEnvVar = answers.keyEnvVar || preset.keyEnv;
  const config = {};
  const envExports = [];
  const notes = [];

  if (answers.model) config.model = answers.model;
  if (answers.heartbeatModel) config.heartbeatModel = answers.heartbeatModel;
  if (answers.gatewayToken) config.gatewayToken = answers.gatewayToken;
  if (answers.sandboxMode) config.sandboxMode = answers.sandboxMode;
  if (answers.localRunner) config.localRunner = answers.localRunner;
  if (answers.sandboxMode && answers.sandboxMode !== 'all') {
    notes.push('Unsandboxed agents run as your user with NO isolation — keep autonomous/untrusted agents sandboxed.');
  }

  const baseUrl = answers.baseUrl || preset.baseUrl;
  if (baseUrl) config.providerBaseUrl = baseUrl;

  if (preset.keyStyle === 'authToken') {
    // Reference, not literal — secrets stay in the environment
    config.providerAuthToken = `\${${keyEnvVar}}`;
    envExports.push(`export ${keyEnvVar}=<your key>`);
  } else if (answers.provider === 'anthropic') {
    envExports.push(`export ANTHROPIC_API_KEY=<your key>`);
  }

  for (const [name, value] of Object.entries(preset.env || {})) {
    envExports.push(`export ${name}=${value}`);
  }
  if (answers.provider === 'bedrock') {
    envExports.push('export AWS_REGION=<region>', 'export AWS_ACCESS_KEY_ID=…', 'export AWS_SECRET_ACCESS_KEY=…');
  }
  if (answers.provider === 'vertex') {
    envExports.push('export CLOUD_ML_REGION=<region>', 'export ANTHROPIC_VERTEX_PROJECT_ID=<project>');
  }
  if (preset.notes) notes.push(preset.notes);

  return { config, envExports, notes };
}

/**
 * Merge a patch into an existing jsclaw.json file, preserving unrelated
 * keys. Reads the raw file (no ${ENV} expansion) so references survive.
 * @param {string} path
 * @param {Object} patch
 * @returns {Object} The merged config that was written
 */
export function mergeConfigFile(path, patch) {
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // absent or invalid — start fresh
  }
  const merged = { ...existing, ...patch };
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/** Scaffold an agent folder with starter identity files (idempotent). */
export function scaffoldAgent(folder, config) {
  const dir = join(config.agentsDir, folder);
  mkdirSync(dir, { recursive: true });
  const created = [];
  for (const [name, content] of [['SOUL.md', SOUL_TEMPLATE], ['HEARTBEAT.md', HEARTBEAT_TEMPLATE]]) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      created.push(name);
    }
  }
  initMemory(folder, config);
  return created;
}

// --- interactive shell ---

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ok    ${label}${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    console.log(`  --    ${label}: ${err.message}`);
    return false;
  }
}

/**
 * Run the wizard.
 * @param {{ config: import('../src/types.js').JsclawConfig }} ctx
 */
export async function runOnboard(ctx) {
  const { config } = ctx;
  if (!process.stdin.isTTY) {
    console.error('jsclaw onboard is interactive — run it in a terminal.');
    process.exit(2);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const answer = (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim();
    return answer || def || '';
  };

  try {
    console.log('\njsclaw onboarding\n=================\n');

    // 1. Environment
    console.log('Environment:');
    check('node >= 20', () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 20) throw new Error(`found ${process.versions.node}`);
      return process.versions.node;
    });
    const hasDocker = check(`container runtime: ${config.containerRuntime}`, () =>
      execSync(`${config.containerRuntime} --version`, { stdio: 'pipe' }).toString().trim().split('\n')[0]
    );
    // 1b. Sandbox posture (openclaw-style)
    console.log('\nAgent sandboxing:');
    let sandboxMode = 'off';
    let localRunner = '';
    if (hasDocker) {
      console.log('  all      — every agent in a container (safest)');
      console.log('  non-main — main agent on the host, others sandboxed');
      console.log('  off      — every agent as a plain process (NO isolation)');
      sandboxMode = await ask('Sandbox mode (all/non-main/off)', 'all');
      if (!['all', 'non-main', 'off'].includes(sandboxMode)) sandboxMode = 'all';
    } else {
      console.log('  No container engine found — agents will run as plain processes.');
      console.log('  ⚠ NO isolation: agents act as your user. Trusted workloads only.');
    }
    if (sandboxMode !== 'all') {
      localRunner = await ask('Runner for unsandboxed agents (path to agent-micro runner.js):');
      if (!localRunner) {
        console.log('  note: set localRunner in jsclaw.json before unsandboxed agents can run');
        console.log('        (git clone https://github.com/jsclaw/agent-micro)');
      }
    }

    const wantsImage = hasDocker && sandboxMode !== 'off';
    const hasImage = wantsImage && check(`agent image: ${config.containerImage}`, () => {
      execSync(`${config.containerRuntime} image inspect ${config.containerImage}`, { stdio: 'pipe' });
      return 'built';
    });

    if (wantsImage && !hasImage) {
      const build = await ask('\nBuild the agent image now? (y/n)', 'y');
      if (build.toLowerCase().startsWith('y')) {
        const containerDir = join(PKG_ROOT, 'container');
        console.log(`\n${config.containerRuntime} build -t ${config.containerImage} ${containerDir}\n`);
        await new Promise((resolve, reject) => {
          const proc = spawn(
            config.containerRuntime,
            ['build', '-t', config.containerImage, '-f', join(containerDir, 'Dockerfile'), containerDir],
            { stdio: 'inherit' },
          );
          proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
          proc.on('error', reject);
        }).catch((err) => console.log(`  build failed: ${err.message} — run it later with: npm run docker:build`));
      }
    }

    // 2. Provider
    console.log('\nModel provider:');
    const keys = Object.keys(PROVIDERS);
    keys.forEach((key, i) => console.log(`  ${i + 1}. ${PROVIDERS[key].label}`));
    const pick = Number(await ask(`\nChoose 1-${keys.length}`, '1'));
    const provider = keys[Math.min(Math.max(pick, 1), keys.length) - 1];
    const preset = PROVIDERS[provider];
    if (preset.notes) console.log(`  note: ${preset.notes}`);

    const answers = { provider, sandboxMode, localRunner };
    if (provider === 'custom') {
      answers.baseUrl = await ask('Endpoint base URL (Anthropic-compatible):');
    }
    answers.keyEnvVar = await ask('Env var holding your API key', preset.keyEnv);
    answers.model = await ask('Default model', preset.models?.[0] || '');
    answers.heartbeatModel = await ask('Heartbeat model (cheaper = ~90% lower autonomy cost)', preset.heartbeatModel || answers.model);
    answers.gatewayToken = randomBytes(16).toString('hex');

    // 3. Write config + scaffold
    const { config: patch, envExports, notes } = buildOnboardConfig(answers);
    const configPath = process.env.JSCLAW_CONFIG_PATH || join(process.cwd(), 'jsclaw.json');
    mergeConfigFile(configPath, patch);
    console.log(`\nWrote ${configPath}`);

    const created = scaffoldAgent('main', config);
    console.log(created.length > 0
      ? `Scaffolded agents/main (${created.join(', ')} + memory/)`
      : 'agents/main already set up — left untouched');

    // 4. Next steps
    console.log('\nNext steps:');
    let step = 1;
    if (envExports.length > 0) {
      console.log(`  ${step++}. Set your credentials:`);
      for (const line of envExports) console.log(`       ${line}`);
    }
    console.log(`  ${step++}. Start the host:   npx jsclaw gateway`);
    console.log(`  ${step++}. Open the chat URL it prints — or: npx jsclaw run main "hello"`);
    for (const note of notes) console.log(`\n  note: ${note}`);
    console.log('');
  } finally {
    rl.close();
  }
}
