#!/usr/bin/env node
/**
 * pi-delegate —— MCP stdio server：把外部 agent（如 Codex）委派的任务交给 pi agent headless 执行
 *
 * 协议：MCP over stdio（按行分隔的 JSON-RPC 2.0），零第三方依赖。
 *
 * 工具：
 *   pi_dispatch        同步执行：阻塞直到 pi 跑完（或超时），返回最终回复
 *   pi_dispatch_start  异步启动：立即返回 task_id，pi 在后台执行
 *   pi_dispatch_poll   异步轮询：查询任务状态 / 增量输出，可阻塞等待
 *
 * 环境变量：
 *   PI_BIN                        pi 可执行文件路径（默认 "pi"，从 PATH 查找）
 *   PI_DELEGATE_MODEL             默认模型，如 "opencode-go/kimi-k2.7-code"（默认不传，用 pi 自身默认）
 *   PI_DELEGATE_CWD               默认工作目录（默认 server 启动目录）
 *   PI_DELEGATE_TIMEOUT_MS        同步执行默认超时（默认 600000 = 10 分钟）
 *   PI_DELEGATE_MAX_OUTPUT_CHARS  返回给调用方的输出上限字符数（默认 100000）
 *   PI_DELEGATE_MAX_CONCURRENT    并发 pi 进程上限（默认 8）
 *
 * 安全提示：pi 会无确认地执行 bash 等工具，委派 = 赋予对目标目录的完整系统访问权限。
 * 只把 cwd 指向你信任的项目。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const PI_BIN = process.env.PI_BIN || "pi";
const DEFAULT_MODEL = process.env.PI_DELEGATE_MODEL || "";
const DEFAULT_CWD = process.env.PI_DELEGATE_CWD || process.cwd();
const DEFAULT_TIMEOUT_MS = intEnv("PI_DELEGATE_TIMEOUT_MS", 600_000);
const MAX_OUTPUT_CHARS = intEnv("PI_DELEGATE_MAX_OUTPUT_CHARS", 100_000);
const MAX_CONCURRENT = intEnv("PI_DELEGATE_MAX_CONCURRENT", 8);
const MAX_TIMEOUT_MS = 3_600_000; // 单任务最长 1 小时
const POLL_WAIT_MAX_SECONDS = 120; // 单次 poll 最长阻塞
const ARGV_PROMPT_LIMIT = 100_000; // 超过则改走 stdin 传入

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------------------------------------------------------------------------
// 任务表
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const tasks = new Map();

function activeCount() {
  let n = 0;
  for (const t of tasks.values()) if (t.state === "running") n++;
  return n;
}

// ---------------------------------------------------------------------------
// pi 子进程
// ---------------------------------------------------------------------------

function validateCwd(cwd) {
  const dir = resolve(cwd || DEFAULT_CWD);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`cwd 不存在或不是目录: ${dir}`);
  }
  return dir;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function buildPiArgs(opts) {
  const args = ["--print"];
  if (opts.sessionId) {
    args.push("--session-id", String(opts.sessionId));
  } else {
    args.push("--no-session");
  }
  if (opts.name) args.push("--name", String(opts.name));
  if (opts.provider) args.push("--provider", String(opts.provider));
  const model = opts.model || DEFAULT_MODEL;
  if (model) args.push("--model", String(model));
  if (opts.thinking) {
    if (!THINKING_LEVELS.has(opts.thinking)) {
      throw new Error(`thinking 取值必须是: ${[...THINKING_LEVELS].join(", ")}`);
    }
    args.push("--thinking", opts.thinking);
  }
  if (opts.noExtensions) args.push("--no-extensions");
  if (opts.trustProject !== false) args.push("--approve");
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", String(opts.appendSystemPrompt));
  args.push("--");
  return args;
}

function startTask(opts) {
  if (activeCount() >= MAX_CONCURRENT) {
    throw new Error(`并发 pi 进程已达上限 ${MAX_CONCURRENT}，请稍后再试`);
  }
  const cwd = validateCwd(opts.cwd);
  const args = buildPiArgs(opts);
  const useStdin = opts.prompt.length > ARGV_PROMPT_LIMIT;
  if (!useStdin) args.push(opts.prompt);

  const id = randomUUID();
  const proc = spawn(PI_BIN, args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const task = {
    id,
    proc,
    prompt: opts.prompt,
    cwd,
    state: "running",
    exitCode: null,
    timedOut: false,
    startedAt: Date.now(),
    endedAt: null,
    stdout: "",
    stderr: "",
    timer: null,
  };
  tasks.set(id, task);

  if (useStdin) {
    proc.stdin.end(opts.prompt + "\n");
  } else {
    proc.stdin.end();
  }

  proc.stdout.on("data", (c) => { task.stdout += c; });
  proc.stderr.on("data", (c) => { task.stderr += c; });
  proc.on("error", (err) => {
    task.state = "error";
    task.endedAt = Date.now();
    task.stderr += `\n[spawn 失败] ${err.message}`;
  });
  proc.on("close", (code) => {
    task.exitCode = code;
    task.state = task.state === "timeout" ? "timeout" : code === 0 ? "done" : "error";
    task.endedAt = Date.now();
    clearTimeout(task.timer);
  });

  task.timer = setTimeout(() => {
    if (task.state !== "running") return;
    task.state = "timeout";
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
  }, clampTimeout(opts.timeoutMs));

  return task;
}

function clampTimeout(ms) {
  const n = Number.parseInt(ms ?? "", 10);
  const value = Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function truncate(text, limit) {
  if (!text) return "";
  if (text.length <= limit) return text;
  return `...[已截断，原始长度 ${text.length} 字符，显示末尾 ${limit} 字符]\n` + text.slice(-limit);
}

function taskSnapshot(task, tailChars) {
  const state = task.state === "running" ? "running" : task.state;
  const parts = [`state: ${state}`];
  parts.push(`cwd: ${task.cwd}`);
  parts.push(`elapsed_ms: ${(task.endedAt ?? Date.now()) - task.startedAt}`);
  if (task.exitCode !== null) parts.push(`exit_code: ${task.exitCode}`);
  if (task.timedOut) parts.push("note: 超时被终止，输出可能不完整");
  const out = truncate(task.stdout.trim(), tailChars);
  const errTail = task.stderr.trim();
  if (out) parts.push(`\n--- pi 输出 ---\n${out}`);
  if (task.state === "error" && errTail) parts.push(`\n--- stderr ---\n${truncate(errTail, 4000)}`);
  if (!out && !errTail && state === "running") parts.push("\n（暂无输出）");
  if (!out && errTail && state !== "error") parts.push(`\n--- stderr ---\n${truncate(errTail, 4000)}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------

const TASK_ARGS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "委派给 pi 的完整任务描述。pi 与调用方的对话互相隔离，请附带全部必要上下文（目标、相关文件路径、约束、验收标准）。" },
    cwd: { type: "string", description: `pi 执行时所在的工作目录（项目根）。默认: ${DEFAULT_CWD}` },
    model: { type: "string", description: `模型，支持 "provider/model" 或模糊匹配，如 "opencode-go/kimi-k2.7-code"。默认: ${DEFAULT_MODEL || "pi 自身默认配置"}` },
    provider: { type: "string", description: "可选，显式指定 provider 名" },
    thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "思考强度（仅对支持 thinking 的模型生效）" },
    session_id: { type: "string", description: "可选，复用/创建一个命名会话实现多轮委派；不传则一次性执行不留存会话" },
    name: { type: "string", description: "可选，会话显示名（仅创建新会话时有意义）" },
    append_system_prompt: { type: "string", description: "可选，追加到 pi 系统提示词的内容（约束其行为）" },
    no_extensions: { type: "boolean", description: "为 true 时不加载 pi 的扩展（更快、更干净，默认 false）" },
    trust_project: { type: "boolean", description: "为 true（默认）时信任项目本地配置（AGENTS.md / .pi/）" },
  },
  required: ["prompt"],
};

const TOOLS = [
  {
    name: "pi_dispatch",
    description:
      "把一个任务委派给 pi agent 执行，阻塞等待直到完成并返回最终回复。" +
      "pi 是一个具备 read/bash/edit/write 工具的编码代理，会在指定目录内自主完成多步操作。" +
      "预计运行时间较长（>几分钟）时，改用 pi_dispatch_start + pi_dispatch_poll。" +
      `默认超时 ${Math.round(DEFAULT_TIMEOUT_MS / 1000)} 秒，可用 timeout_ms 调整（上限 1 小时）。`,
    inputSchema: {
      ...TASK_ARGS,
      properties: {
        ...TASK_ARGS.properties,
        timeout_ms: { type: "number", description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 3600000` },
      },
    },
  },
  {
    name: "pi_dispatch_start",
    description:
      "异步启动一个 pi agent 任务，立即返回 task_id，不阻塞。" +
      "之后用 pi_dispatch_poll 查询进度与结果。适合长任务（构建、重构、批量修改）。",
    inputSchema: TASK_ARGS,
  },
  {
    name: "pi_dispatch_poll",
    description:
      "查询委派任务的状态与输出。可用 wait_seconds 阻塞等待（上限 120 秒），" +
      "适合在任务完成前循环调用。任务结束后再次调用返回同样结果。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "pi_dispatch_start 返回的 task_id" },
        wait_seconds: { type: "number", description: "最多阻塞等待的秒数（0-120，默认 0）" },
        tail_chars: { type: "number", description: "返回输出末尾的字符数（默认 20000）" },
      },
      required: ["task_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

function parseTaskArgs(raw) {
  if (!raw || typeof raw !== "object") throw new Error("缺少参数对象");
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) throw new Error("prompt 不能为空");
  return raw;
}

async function callTool(name, args) {
  if (name === "pi_dispatch" || name === "pi_dispatch_start") {
    const opts = parseTaskArgs(args);
    const task = startTask(opts);
    if (name === "pi_dispatch_start") {
      return { text: `task_id: ${task.id}\nstate: running\ncwd: ${task.cwd}\n用 pi_dispatch_poll 查询进度与结果。` };
    }
    await waitFor(task, clampTimeout(opts.timeoutMs) + 1000);
    const ok = task.state === "done" && task.exitCode === 0;
    return {
      text: taskSnapshot(task, MAX_OUTPUT_CHARS),
      isError: !ok,
    };
  }

  if (name === "pi_dispatch_poll") {
    const task = tasks.get(String(args?.task_id ?? ""));
    if (!task) throw new Error(`未知 task_id: ${args?.task_id}（server 重启后任务丢失）`);
    const wait = Math.min(Math.max(0, Number(args?.wait_seconds) || 0), POLL_WAIT_MAX_SECONDS) * 1000;
    await waitFor(task, wait);
    return {
      text: taskSnapshot(task, Math.max(500, Math.min(Number(args?.tail_chars) || 20_000, MAX_OUTPUT_CHARS))),
      isError: task.state === "error" || task.state === "timeout",
    };
  }

  throw new Error(`未知工具: ${name}`);
}

function waitFor(task, ms) {
  if (task.state !== "running") return Promise.resolve();
  return new Promise((res) => {
    const check = setInterval(() => {
      if (task.state !== "running") { clearInterval(check); res(); }
    }, 100);
    setTimeout(() => { clearInterval(check); res(); }, Math.max(0, ms));
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP 协议层
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "pi-delegate", version: "0.1.0" };

function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      // 异步执行，完成后补发响应
      callTool(params?.name, params?.arguments)
        .then((r) => write({
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: r.text }],
            ...(r.isError ? { isError: true } : {}),
          },
        }))
        .catch((err) => write({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true },
        }));
      return null; // 响应延后发送
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } };
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.id === undefined || msg.id === null) return; // notification，忽略
  const resp = handleRequest(msg);
  if (resp) write(resp);
});
rl.on("close", () => {
  // stdin 关闭（客户端退出）：终止仍在运行的 pi 子进程后退出
  for (const task of tasks.values()) {
    if (task.state === "running") { try { task.proc.kill("SIGTERM"); } catch {} }
  }
  process.exit(0);
});

process.on("exit", () => {
  for (const task of tasks.values()) {
    if (task.state === "running") { try { task.proc.kill("SIGTERM"); } catch {} }
  }
});

process.stderr.write(`[pi-delegate] MCP server ready (pi: ${PI_BIN}, default model: ${DEFAULT_MODEL || "(pi 默认)"}, default cwd: ${DEFAULT_CWD})\n`);