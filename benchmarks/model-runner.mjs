import { spawn } from 'node:child_process';

function parseArgsJson(value) {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('LOCALWORKSPACEBRIDGE_BENCH_MODEL_ARGS must be a JSON array of strings.');
  }
  return parsed;
}

function runCommand(command, args, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Model runner timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Model runner exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Model runner returned invalid JSON: ${stdout.slice(0, 2000)}\n${error}`));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

export function modelRunnerConfigFromEnv() {
  const command = process.env.LOCALWORKSPACEBRIDGE_BENCH_MODEL_COMMAND?.trim();
  if (!command) {
    return {
      configured: false,
      status: 'pending',
      reason: 'LOCALWORKSPACEBRIDGE_BENCH_MODEL_COMMAND is not configured. Model-dependent Pass@1/pass^k/token/cost metrics are intentionally not fabricated.'
    };
  }
  return {
    configured: true,
    command,
    args: parseArgsJson(process.env.LOCALWORKSPACEBRIDGE_BENCH_MODEL_ARGS),
    modelName: process.env.LOCALWORKSPACEBRIDGE_BENCH_MODEL_NAME?.trim() || 'external-fixed-model',
    modelVersion: process.env.LOCALWORKSPACEBRIDGE_BENCH_MODEL_VERSION?.trim() || 'unspecified',
    timeoutMs: Number(process.env.LOCALWORKSPACEBRIDGE_BENCH_MODEL_TIMEOUT_MS || 120000),
    maxTurns: Number(process.env.LOCALWORKSPACEBRIDGE_BENCH_MODEL_MAX_TURNS || 20)
  };
}

/**
 * External runner protocol.
 *
 * The command receives one JSON object on stdin and must return one JSON object on stdout.
 * Every turn receives:
 *   {
 *     protocol: "local-workspace-bridge-agent-eval-v1",
 *     model: {name, version},
 *     task: {id, prompt},
 *     tool_mode: "minimal" | "standard" | "full",
 *     tools: [{name, description, inputSchema}],
 *     transcript: [{role:"tool", name, arguments, result}],
 *     turn: number
 *   }
 *
 * It must answer with exactly one of:
 *   {"type":"tool_call","name":"read","arguments":{...},"usage":{"input_tokens":0,"output_tokens":0,"cost_usd":0}}
 *   {"type":"final","answer":"...","usage":{"input_tokens":0,"output_tokens":0,"cost_usd":0}}
 *
 * Usage fields are optional, but benchmark reports token/cost metrics only when the runner supplies them.
 */
export function createExternalModelRunner(config = modelRunnerConfigFromEnv()) {
  if (!config.configured) return null;
  return {
    metadata: {
      name: config.modelName,
      version: config.modelVersion,
      adapter: 'external-command-v1'
    },
    async next(payload) {
      const response = await runCommand(config.command, config.args, payload, config.timeoutMs);
      if (!response || !['tool_call', 'final'].includes(response.type)) {
        throw new Error(`Model runner response must have type=tool_call or type=final: ${JSON.stringify(response)}`);
      }
      return response;
    },
    maxTurns: config.maxTurns
  };
}
