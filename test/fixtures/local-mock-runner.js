/**
 * Mock local-mode runner for tests. Speaks the container contract:
 * ContainerInput JSON on stdin, sentinel-delimited ContainerOutput on
 * stdout. Echoes its env so tests can assert the local-mode wiring.
 * With input.hang set, stays alive after replying (timeout/kill tests).
 */

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const output = {
    status: 'success',
    result: JSON.stringify({
      prompt: input.prompt,
      workspace: process.env.JSCLAW_WORKSPACE || null,
      ipcBase: process.env.JSCLAW_IPC_BASE || null,
      agentId: process.env.JSCLAW_AGENT_ID || null,
      isMain: process.env.JSCLAW_IS_MAIN || null,
      skillsIndex: input.skillsIndex || null,
      hasProviderEnv: Boolean(input.providerEnv),
    }),
    newSessionId: 'mock-session',
  };
  process.stdout.write(`---JSCLAW_OUTPUT_START---\n${JSON.stringify(output)}\n---JSCLAW_OUTPUT_END---\n`);
  if (!input.hang) process.exit(0);
  // hang: stay alive until killed, like a real runner polling for IPC
  setInterval(() => {}, 1000);
});
