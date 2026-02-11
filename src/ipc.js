/**
 * Host-side IPC watcher. Polls container IPC directories for messages and tasks.
 * @module ipc
 */

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drainIpcDir } from './ipc-utils.js';
import { createConfig } from './config.js';

/** @type {NodeJS.Timeout|null} */
let pollHandle = null;

/**
 * Start the IPC watcher loop.
 *
 * @param {import('./types.js').IpcDeps} deps - Callback dependencies
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {{ stop: () => void }}
 */
export function startIpcWatcher(deps, config) {
  config = config || createConfig();
  const log = config.logger;
  const ipcBase = join(config.dataDir, 'ipc');

  mkdirSync(ipcBase, { recursive: true });

  async function poll() {
    let groupDirs;
    try {
      groupDirs = readdirSync(ipcBase, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return;
    }

    const groups = deps.getRegisteredGroups();

    for (const groupFolder of groupDirs) {
      const isMain = Object.values(groups).some(
        (g) => g.folder === groupFolder && g.folder === 'main'
      );

      // Process outbound messages (container -> host)
      const messagesDir = join(ipcBase, groupFolder, 'messages');
      const messages = drainIpcDir(messagesDir);

      for (const { data, filename } of messages) {
        try {
          const targetJid = data.targetJid || data.target_jid;
          const text = data.text;
          const sender = data.sender;

          if (!text) {
            log.warn(`IPC message missing text`, { filename, groupFolder });
            continue;
          }

          // Authorization: non-main groups can only send to their own chat
          if (!isMain && targetJid) {
            const group = Object.values(groups).find((g) => g.folder === groupFolder);
            if (group && targetJid !== group.jid) {
              log.warn(`Non-main group attempted cross-group message`, {
                groupFolder,
                targetJid,
              });
              continue;
            }
          }

          const resolvedJid = targetJid || Object.values(groups).find((g) => g.folder === groupFolder)?.jid;
          if (resolvedJid) {
            await deps.sendMessage(resolvedJid, text, sender);
          }
        } catch (err) {
          log.error(`Failed to process IPC message`, {
            error: err.message,
            filename,
            groupFolder,
          });
          moveToErrors(messagesDir, filename, data, config);
        }
      }

      // Process task operations (container -> host)
      const tasksDir = join(ipcBase, groupFolder, 'tasks');
      const tasks = drainIpcDir(tasksDir);

      for (const { data, filename } of tasks) {
        try {
          const type = data.type;
          if (!type) {
            log.warn(`IPC task missing type`, { filename, groupFolder });
            continue;
          }

          await deps.onTask(type, data.data || data, groupFolder, isMain);
        } catch (err) {
          log.error(`Failed to process IPC task`, {
            error: err.message,
            filename,
            groupFolder,
          });
          moveToErrors(tasksDir, filename, data, config);
        }
      }
    }
  }

  // Start polling
  pollHandle = setInterval(poll, config.ipcPollInterval);
  // Run immediately
  poll();

  return {
    stop() {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    },
  };
}

/**
 * Move a failed IPC file to the errors directory.
 * @param {string} sourceDir
 * @param {string} filename
 * @param {Object} data
 * @param {import('./types.js').JsclawConfig} config
 */
function moveToErrors(sourceDir, filename, data, config) {
  try {
    const errorsDir = join(sourceDir, 'errors');
    mkdirSync(errorsDir, { recursive: true });
    writeFileSync(join(errorsDir, filename), JSON.stringify(data));
  } catch {
    // best effort
  }
}
