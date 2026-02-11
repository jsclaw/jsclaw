/**
 * Container execution engine. Spawns Docker/Podman/Apple containers
 * and streams Claude agent output via sentinel-delimited JSON.
 * @module container-runner
 */

import { spawn, exec } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from './config.js';

const OUTPUT_START_MARKER = '---JSCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---JSCLAW_OUTPUT_END---';

/**
 * Build the volume mount arguments for the container runtime.
 * @param {import('./types.js').GroupConfig} group
 * @param {import('./types.js').JsclawConfig} config
 * @returns {string[]} CLI arguments for volume mounts
 */
export function buildVolumeMounts(group, config) {
  const args = [];
  const groupDir = join(config.groupsDir, group.folder);
  const ipcDir = join(config.dataDir, 'ipc', group.folder);

  // Ensure directories exist
  for (const dir of [groupDir, join(ipcDir, 'messages'), join(ipcDir, 'tasks'), join(ipcDir, 'input')]) {
    mkdirSync(dir, { recursive: true });
  }

  // Group workspace (read-write)
  args.push('-v', `${groupDir}:/workspace/group`);

  // IPC directories
  args.push('-v', `${ipcDir}/messages:/workspace/ipc/messages`);
  args.push('-v', `${ipcDir}/tasks:/workspace/ipc/tasks`);
  args.push('-v', `${ipcDir}/input:/workspace/ipc/input`);

  // Additional mounts from group config
  if (group.additionalMounts) {
    for (const mount of group.additionalMounts) {
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

  // Environment variables
  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', `${key}=${value}`);
  }

  // Pass through ANTHROPIC_API_KEY if set
  if (process.env.ANTHROPIC_API_KEY) {
    args.push('-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  }

  args.push(...mountArgs);
  args.push(config.containerImage);

  return args;
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
 * @param {import('./types.js').GroupConfig} group - Group configuration
 * @param {import('./types.js').ContainerInput} input - Agent input
 * @param {(proc: import('node:child_process').ChildProcess, containerName: string) => void} [onProcess] - Called when container starts
 * @param {(output: import('./types.js').ContainerOutput) => Promise<void>} [onOutput] - Called for each streaming output
 * @param {import('./types.js').JsclawConfig} [config] - Configuration
 * @returns {Promise<import('./types.js').ContainerOutput>}
 */
export async function runContainerAgent(group, input, onProcess, onOutput, config) {
  config = config || createConfig();
  const log = config.logger;
  const containerName = `jsclaw-${group.folder}-${Date.now()}`;

  const mountArgs = buildVolumeMounts(group, config);
  const envVars = {
    JSCLAW_CHAT_JID: input.chatJid,
    JSCLAW_GROUP_FOLDER: input.groupFolder,
    JSCLAW_IS_MAIN: String(input.isMain),
  };
  const args = buildContainerArgs(mountArgs, containerName, config, envVars);

  log.info(`Spawning container: ${containerName}`, { group: group.folder });

  return new Promise((resolve, reject) => {
    const proc = spawn(config.containerRuntime, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
 * Kill a running container.
 * @param {string} containerName
 * @param {import('./types.js').JsclawConfig} config
 */
function killContainer(containerName, config) {
  exec(`${config.containerRuntime} stop ${containerName}`, (err) => {
    if (err) {
      // Force kill if stop fails
      exec(`${config.containerRuntime} kill ${containerName}`, () => {});
    }
  });
}

/**
 * Write a tasks snapshot file for the agent to read.
 * @param {string} groupFolder
 * @param {Object[]} tasks
 * @param {import('./types.js').JsclawConfig} config
 */
export function writeTasksSnapshot(groupFolder, tasks, config) {
  const dir = join(config.groupsDir, groupFolder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'current_tasks.json'), JSON.stringify(tasks, null, 2));
}
