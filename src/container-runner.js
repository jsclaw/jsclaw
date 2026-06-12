/**
 * Container execution engine. Spawns Docker/Podman/Apple containers —
 * or, with containerRuntime 'local', plain child processes with NO
 * isolation — and streams Claude agent output via sentinel-delimited JSON.
 * @module container-runner
 */

import { spawn, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from './config.js';
import { resolveProviderEnv } from './providers.js';
import { loadSkills, matchSkills, buildSkillContext, buildSkillsIndex } from './skills.js';
import { normalizeAgentId } from './agents.js';
import { relative } from 'node:path';

/** Container-side mount point for the read-only skills volume. */
const SKILLS_MOUNT = '/workspace/skills';

/**
 * Resolve the skills payload for one agent run: triggered skill bodies
 * to prepend to the prompt, and the description-driven index for the
 * system prompt — with paths the agent can actually read (host paths
 * in local mode, the read-only mount inside containers).
 * @param {import('./types.js').JsclawConfig} config
 * @param {string} prompt
 * @param {boolean} isLocal
 * @returns {{ promptPrefix: string, skillsIndex: string }}
 */
export function resolveSkillsForRun(config, prompt, isLocal) {
  const skills = loadSkills(config);
  if (skills.length === 0) return { promptPrefix: '', skillsIndex: '' };

  const triggered = matchSkills(skills, { text: prompt || '' });
  const promptPrefix = buildSkillContext(triggered);

  const visible = isLocal ? skills : skills.map((s) => ({
    ...s,
    path: s.path ? `${SKILLS_MOUNT}/${relative(config.skillsDir, s.path)}` : s.path,
  }));
  return { promptPrefix, skillsIndex: buildSkillsIndex(visible) };
}

const OUTPUT_START_MARKER = '---JSCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---JSCLAW_OUTPUT_END---';

/** Live local-mode child processes, keyed by container name. */
const localProcs = new Map();

/** Memoized container-engine availability checks, keyed by runtime name. */
const engineChecks = new Map();

/**
 * Whether the configured container engine is present and responding.
 * Memoized per runtime name for the process lifetime.
 * @param {import('./types.js').JsclawConfig} config
 * @returns {Promise<boolean>}
 */
export function engineAvailable(config) {
  const runtime = config.containerRuntime;
  if (!engineChecks.has(runtime)) {
    engineChecks.set(runtime, execFileAsync(runtime, ['info'], { timeout: 5000 })
      .then(() => true, () => false));
  }
  return engineChecks.get(runtime);
}

/** @internal Reset the engine-availability memo (tests only). */
export function _resetEngineChecks() {
  engineChecks.clear();
}

/**
 * Decide whether this run is sandboxed (container) or local (plain
 * process), openclaw-style. Per-agent `sandbox` wins; otherwise the
 * global sandboxMode: 'off' | 'all' | 'non-main' | 'auto' (sandbox
 * when the container engine is actually available).
 * @param {import('./types.js').AgentConfig} agent
 * @param {import('./types.js').ContainerInput} input
 * @param {import('./types.js').JsclawConfig} config
 * @returns {Promise<boolean>}
 */
export async function resolveSandbox(agent, input, config) {
  if (config.containerRuntime === 'local') {
    throw new Error(`containerRuntime 'local' was replaced by sandboxMode: 'off' (set containerRuntime back to your engine, e.g. 'docker')`);
  }
  if (typeof agent.sandbox === 'boolean') return agent.sandbox;

  const mode = config.sandboxMode ?? 'auto';
  switch (mode) {
    case 'off': return false;
    case 'all': return true;
    case 'non-main': return !input.isMain;
    case 'auto': return engineAvailable(config);
    default:
      throw new Error(`Unknown sandboxMode: '${mode}' (expected 'auto', 'off', 'all', or 'non-main')`);
  }
}

/** Pidfile directory for local-mode orphan reaping across host restarts. */
function localPidDir(config) {
  return join(config.dataDir, 'local-runners');
}

/**
 * Resolve (and create) the host-side directories for an agent.
 * @param {import('./types.js').AgentConfig} agent
 * @param {import('./types.js').JsclawConfig} config
 * @returns {{ agentDir: string, ipcDir: string }}
 */
export function ensureAgentDirs(agent, config) {
  const agentDir = join(config.agentsDir, agent.folder);
  const ipcDir = join(config.dataDir, 'ipc', agent.folder);
  for (const dir of [agentDir, join(ipcDir, 'messages'), join(ipcDir, 'tasks'), join(ipcDir, 'input')]) {
    mkdirSync(dir, { recursive: true });
  }
  return { agentDir, ipcDir };
}

/**
 * Build the volume mount arguments for the container runtime.
 * @param {import('./types.js').AgentConfig} agent
 * @param {import('./types.js').JsclawConfig} config
 * @returns {string[]} CLI arguments for volume mounts
 */
export function buildVolumeMounts(agent, config) {
  const args = [];
  const { agentDir, ipcDir } = ensureAgentDirs(agent, config);

  // Agent workspace (read-write)
  args.push('-v', `${agentDir}:/workspace/agent`);

  // Skills (read-only) — agents read SKILL.md bodies on demand
  if (existsSync(config.skillsDir)) {
    args.push('-v', `${config.skillsDir}:${SKILLS_MOUNT}:ro`);
  }

  // IPC directories
  args.push('-v', `${ipcDir}/messages:/workspace/ipc/messages`);
  args.push('-v', `${ipcDir}/tasks:/workspace/ipc/tasks`);
  args.push('-v', `${ipcDir}/input:/workspace/ipc/input`);

  // Additional mounts from agent config
  if (agent.additionalMounts) {
    for (const mount of agent.additionalMounts) {
      if (mount.readOnly) {
        args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }
  }

  return args;
}

/**
 * Build the full container spawn arguments.
 * @param {string[]} mountArgs - Volume mount arguments
 * @param {string} containerName - Unique container name
 * @param {import('./types.js').JsclawConfig} config
 * @param {Object} [envVars] - Additional environment variables
 * @returns {string[]}
 */
export function buildContainerArgs(mountArgs, containerName, config, envVars = {}) {
  const args = [
    'run', '-i', '--rm',
    '--name', containerName,
  ];

  // Environment variables (non-secret JSCLAW_* only — credentials travel
  // via stdin in ContainerInput.providerEnv; argv leaks into `ps`)
  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(...mountArgs);
  args.push(config.containerImage);

  return args;
}

/**
 * Resolve the MCP servers to hand to a container: global config.mcp.servers
 * merged with the agent's mcpServers (agent wins by name). The 'jsclaw'
 * name is reserved for the built-in IPC server and is stripped.
 *
 * Passed to the container via stdin (ContainerInput), never argv or env —
 * MCP entries carry credentials and argv leaks into `ps`.
 *
 * @param {import('./types.js').AgentConfig} agent
 * @param {import('./types.js').JsclawConfig} config
 * @returns {Record<string, Object>|undefined} undefined when nothing is configured
 */
export function resolveMcpServers(agent, config) {
  const merged = { ...(config.mcp?.servers || {}), ...(agent.mcpServers || {}) };
  if ('jsclaw' in merged) {
    config.logger.warn(`MCP server name 'jsclaw' is reserved for the built-in server — ignoring`);
    delete merged.jsclaw;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Parse sentinel-delimited output from container stdout.
 * @param {string} buffer - Accumulated stdout text
 * @returns {{ outputs: import('./types.js').ContainerOutput[], remaining: string }}
 */
export function parseContainerOutput(buffer) {
  const outputs = [];
  let remaining = buffer;

  while (true) {
    const startIdx = remaining.indexOf(OUTPUT_START_MARKER);
    if (startIdx === -1) break;

    const afterStart = startIdx + OUTPUT_START_MARKER.length;
    const endIdx = remaining.indexOf(OUTPUT_END_MARKER, afterStart);
    if (endIdx === -1) break; // incomplete output, keep in buffer

    const jsonStr = remaining.slice(afterStart, endIdx).trim();
    try {
      outputs.push(JSON.parse(jsonStr));
    } catch {
      outputs.push({ status: 'error', result: null, error: `Failed to parse output: ${jsonStr.slice(0, 200)}` });
    }

    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);
  }

  return { outputs, remaining };
}

/**
 * Run a Claude agent inside a container.
 *
 * @param {import('./types.js').AgentConfig} agent - Agent configuration
 * @param {import('./types.js').ContainerInput} input - Agent input
 * @param {(proc: import('node:child_process').ChildProcess, containerName: string) => void} [onProcess] - Called when container starts
 * @param {(output: import('./types.js').ContainerOutput) => Promise<void>} [onOutput] - Called for each streaming output
 * @param {import('./types.js').JsclawConfig} [config] - Configuration
 * @returns {Promise<import('./types.js').ContainerOutput>}
 */
export async function runContainerAgent(agent, input, onProcess, onOutput, config) {
  config = config || createConfig();
  const log = config.logger;
  // Defensive net: agent.folder becomes a path and a container name —
  // normalize regardless of caller (closes traversal even if a boundary missed it).
  agent = { ...agent, folder: normalizeAgentId(agent.folder) };
  const containerName = `jsclaw-${agent.folder}-${Date.now()}`;

  const mcpServers = resolveMcpServers(agent, config);
  const providerEnv = resolveProviderEnv(config);
  // Model precedence: explicit input > agent > config default
  const model = input.model ?? agent.model ?? config.model;
  input = {
    ...input,
    ...(mcpServers && { mcpServers }),
    ...(providerEnv && { providerEnv }),
    ...(model && { model }),
  };

  const isLocal = !(await resolveSandbox(agent, input, config));

  // Skills: triggered bodies ride the prompt, the index rides the input
  const { promptPrefix, skillsIndex } = resolveSkillsForRun(config, input.prompt, isLocal);
  if (promptPrefix || skillsIndex) {
    input = {
      ...input,
      ...(promptPrefix && { prompt: `${promptPrefix}\n\n${input.prompt}` }),
      ...(skillsIndex && { skillsIndex }),
    };
  }

  const envVars = {
    JSCLAW_CHAT_JID: input.chatJid,
    JSCLAW_AGENT_ID: input.agentId,
    JSCLAW_IS_MAIN: String(input.isMain),
  };

  let spawnCmd, spawnArgs, spawnOpts;
  if (isLocal) {
    if (!config.localRunner) {
      return Promise.reject(new Error(
        `Agent '${agent.folder}' resolved to local (unsandboxed) mode but localRunner is not set. ` +
        `Point localRunner at a runner entrypoint (e.g. agent-micro's runner.js), ` +
        `or set sandboxMode: 'all' with a container engine installed.`
      ));
    }
    if (!existsSync(config.localRunner)) {
      return Promise.reject(new Error(`localRunner not found: ${config.localRunner}`));
    }
    const { agentDir, ipcDir } = ensureAgentDirs(agent, config);
    if (agent.additionalMounts?.length) {
      log.warn(`additionalMounts are ignored in local mode (no isolation): ${agent.folder}`);
    }
    spawnCmd = process.execPath;
    spawnArgs = [config.localRunner];
    spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...envVars,
        JSCLAW_WORKSPACE: agentDir,
        JSCLAW_IPC_BASE: ipcDir,
      },
    };
    log.info(`Spawning local agent process (NO isolation): ${containerName}`, { agent: agent.folder });
  } else {
    const mountArgs = buildVolumeMounts(agent, config);
    spawnCmd = config.containerRuntime;
    spawnArgs = buildContainerArgs(mountArgs, containerName, config, envVars);
    spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
    log.info(`Spawning container: ${containerName}`, { agent: agent.folder });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(spawnCmd, spawnArgs, spawnOpts);

    if (isLocal) {
      localProcs.set(containerName, proc);
      try {
        mkdirSync(localPidDir(config), { recursive: true });
        if (proc.pid) writeFileSync(join(localPidDir(config), `${containerName}.pid`), String(proc.pid));
      } catch { /* pidfile is best-effort; reaping degrades gracefully */ }
    }

    if (onProcess) {
      onProcess(proc, containerName);
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let lastOutput = null;
    let timedOut = false;

    // Idle timeout - resets on each output
    let timeoutHandle = setTimeout(() => {
      timedOut = true;
      log.warn(`Container timed out: ${containerName}`);
      killContainer(containerName, config);
    }, config.containerTimeout);

    function resetTimeout() {
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        log.warn(`Container timed out: ${containerName}`);
        killContainer(containerName, config);
      }, config.containerTimeout);
    }

    proc.stdout.on('data', async (chunk) => {
      stdoutBuffer += chunk.toString();

      // Check buffer size limit
      if (stdoutBuffer.length > config.maxOutputSize) {
        log.error(`Output exceeds max size, killing container: ${containerName}`);
        killContainer(containerName, config);
        return;
      }

      const { outputs, remaining } = parseContainerOutput(stdoutBuffer);
      stdoutBuffer = remaining;

      for (const output of outputs) {
        lastOutput = output;
        resetTimeout();
        if (onOutput) {
          try {
            await onOutput(output);
          } catch (err) {
            log.error(`onOutput callback error`, { error: err.message });
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      // Limit stderr buffer too
      if (stderrBuffer.length > config.maxOutputSize) {
        stderrBuffer = stderrBuffer.slice(-config.maxOutputSize / 2);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (isLocal) {
        localProcs.delete(containerName);
        try { rmSync(join(localPidDir(config), `${containerName}.pid`), { force: true }); } catch { /* best-effort */ }
      }

      if (timedOut) {
        resolve({
          status: 'error',
          result: lastOutput?.result || null,
          error: `Container timed out after ${config.containerTimeout}ms`,
          newSessionId: lastOutput?.newSessionId,
        });
        return;
      }

      if (lastOutput) {
        resolve(lastOutput);
      } else if (code === 0) {
        resolve({ status: 'success', result: null });
      } else {
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}. stderr: ${stderrBuffer.slice(-500)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn container: ${err.message}`));
    });

    // Write input to stdin and close
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

/**
 * Kill a running container or local agent process.
 * @param {string} containerName
 * @param {import('./types.js').JsclawConfig} config
 */
function killContainer(containerName, config) {
  const proc = localProcs.get(containerName);
  if (proc) {
    proc.kill('SIGTERM');
    // Escalate if the runner ignores SIGTERM
    const force = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, 5000);
    force.unref?.();
    return;
  }
  exec(`${config.containerRuntime} stop ${containerName}`, (err) => {
    if (err) {
      // Force kill if stop fails
      exec(`${config.containerRuntime} kill ${containerName}`, () => {});
    }
  });
}

const execFileAsync = promisify(execFile);

/**
 * Remove orphaned jsclaw containers left behind by a crashed host.
 *
 * Call this at startup, before spawning any agents: if the previous
 * host process died uncleanly, its containers keep running unsupervised
 * — burning tokens — and the restarted host would otherwise spawn a
 * duplicate agent over the same agent folder and IPC directory.
 *
 * @param {import('./types.js').JsclawConfig} [config]
 * @param {{ prefix?: string }} [opts] - Container-name prefix to sweep (default 'jsclaw-')
 * @returns {Promise<string[]>} Names of the containers that were removed
 */
export async function reapOrphanContainers(config, opts = {}) {
  config = config || createConfig();
  const log = config.logger;
  const { prefix = 'jsclaw-' } = opts;
  const runtime = config.containerRuntime;

  // Local runners can exist under any sandboxMode (per-agent overrides,
  // 'non-main', 'auto' fallback) — always sweep the pidfiles.
  const reapedLocal = await reapOrphanLocalRunners(config, prefix);

  // Engine sweep only where containers can exist at all
  if (config.sandboxMode === 'off' || !(await engineAvailable(config))) {
    return reapedLocal;
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(runtime, ['ps', '--format', '{{.Names}}'], { timeout: 15000 }));
  } catch (err) {
    log.warn(`Orphan sweep skipped: ${runtime} ps failed`, { error: err.message });
    return reapedLocal;
  }

  const orphans = stdout.split('\n').map((n) => n.trim()).filter((n) => n.startsWith(prefix));
  const reaped = [...reapedLocal];

  for (const name of orphans) {
    try {
      // rm -f kills and removes in one step, whether or not it ran with --rm
      await execFileAsync(runtime, ['rm', '-f', name], { timeout: 30000 });
      log.warn(`Reaped orphaned container: ${name}`);
      reaped.push(name);
    } catch (err) {
      log.error(`Failed to reap orphaned container: ${name}`, { error: err.message });
    }
  }

  return reaped;
}

/**
 * Reap orphaned local-mode agent processes via pidfiles. A pidfile with
 * a dead pid is just cleaned up; a live pid from a previous host run is
 * killed (same rationale as the container sweep: an unsupervised agent
 * burns tokens and races a fresh spawn over the same IPC dirs).
 * @param {import('./types.js').JsclawConfig} config
 * @param {string} prefix
 * @returns {Promise<string[]>} Names of the runners that were reaped
 */
async function reapOrphanLocalRunners(config, prefix) {
  const log = config.logger;
  const dir = localPidDir(config);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.pid') && f.startsWith(prefix));
  } catch {
    return []; // no pidfile dir yet — nothing to reap
  }

  const reaped = [];
  for (const file of files) {
    const name = file.slice(0, -4);
    if (localProcs.has(name)) continue; // supervised by this process
    const pidPath = join(dir, file);
    const pid = Number(readFileSync(pidPath, 'utf-8').trim());
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
        log.warn(`Reaped orphaned local runner: ${name} (pid ${pid})`);
        reaped.push(name);
      } catch { /* already dead — stale pidfile */ }
    }
    rmSync(pidPath, { force: true });
  }

  return reaped;
}

/**
 * Write a tasks snapshot file for the agent to read.
 * @param {string} agentId
 * @param {Object[]} tasks
 * @param {import('./types.js').JsclawConfig} config
 */
export function writeTasksSnapshot(agentId, tasks, config) {
  const dir = join(config.agentsDir, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'current_tasks.json'), JSON.stringify(tasks, null, 2));
}
