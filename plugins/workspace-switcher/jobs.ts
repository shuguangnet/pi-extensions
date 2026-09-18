/**
 * workspace-switcher —— 后台任务
 *
 * 每个后台任务 = 一个独立的 `pi --mode rpc` 子进程，跑在指定目录、可绑定指定会话文件。
 * 它与主 pi 进程完全隔离：主 TUI 切换会话 / 目录都不会中断它；任务结束后主 TUI 收到通知。
 *
 * 协议参考 `@earendil-works/pi-coding-agent/docs/rpc.md`：stdin 写 JSONL 命令，stdout 读 JSONL 事件。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { AUTO_APPROVE_DIALOGS, EXTRA_PI_ARGS, MAX_JOBS, PI_BINARY, PREVIEW_CHARS } from "./config";

export type JobStatus = "starting" | "running" | "idle" | "exited" | "failed";

/** 一个后台任务的可见状态。 */
export interface BackgroundJob {
  id: string;
  /** 任务运行的目录（子进程 cwd）。 */
  cwd: string;
  /** 展示用标题：会话名 / 目录名。 */
  title: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  /** 绑定的会话文件（新任务会在首次交互后补齐）。 */
  sessionFile?: string;
  /** 使用的模型，形如 `provider/modelId`。 */
  model?: string;
  /** 首个指令。 */
  prompt?: string;
  /** 最近一次助手回复全文。 */
  lastText: string;
  /** 正在流式输出的助手文本。 */
  streamingText: string;
  /** 最近一次工具调用名。 */
  lastTool?: string;
  /** 已完成的轮次数。 */
  turns: number;
  error?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  /** 子进程 stderr 尾部，出错时便于排查。 */
  stderrTail: string;
  /** 有新输出且用户还没看过。 */
  unread: boolean;
}

export type JobUpdate =
  | { kind: "started" }
  | { kind: "running" }
  | { kind: "tool"; tool: string }
  | { kind: "assistant"; text: string }
  | { kind: "settled" }
  | { kind: "failed"; message: string }
  | { kind: "exited" };

type JobListener = (job: BackgroundJob, update: JobUpdate) => void;

export interface StartJobOptions {
  /** 子进程运行目录。 */
  cwd: string;
  /** 展示标题。 */
  title: string;
  /** 首个指令。 */
  prompt: string;
  /** 续跑已有会话时传该会话文件。 */
  sessionFile?: string;
  /** `provider/modelId`，省略则用 pi 默认模型。 */
  model?: string;
  /** 可执行文件覆盖（默认 config.PI_BINARY）。 */
  piBinary?: string;
}

/** 组装子进程参数。 */
function buildArgs(opts: StartJobOptions): string[] {
  const args = ["--mode", "rpc"];
  if (opts.sessionFile) {
    args.push("--session", opts.sessionFile);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push(...EXTRA_PI_ARGS);
  return args;
}

/** 从一个 RPC 事件里抽出助手文本。 */
function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

/** 尾部截断，保留最近的内容。 */
function tail(text: string, max = PREVIEW_CHARS): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max)}`;
}

/** 过滤 npm 一类的启动噪音，只保留有用的 stderr。 */
function cleanStderr(chunk: string): string {
  return chunk
    .split("\n")
    .filter((line) => line.trim() && !/^npm (warn|notice)/.test(line.trim()))
    .join("\n");
}

/**
 * 一个 `pi --mode rpc` 子进程的薄封装：
 * JSONL 分帧、请求/响应关联、扩展弹窗兜底、退出处理。
 */
class RpcClient {
  readonly child: ChildProcessWithoutNullStreams;

  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, (msg: Record<string, any>) => void>();
  private exited = false;
  private killTimer?: NodeJS.Timeout;

  constructor(
    bin: string,
    args: string[],
    cwd: string,
    private readonly hooks: {
      onMessage: (msg: Record<string, any>) => void;
      onStderr: (chunk: string) => void;
      onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
      onError: (error: Error) => void;
    },
  ) {
    this.child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => this.hooks.onStderr(chunk));
    this.child.on("error", (error) => this.hooks.onError(error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.hooks.onExit(code, signal);
    });
  }

  /** 按 LF 分帧（RPC 协议只认 \n）。 */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      // 非协议行（例如扩展直接写 stdout）忽略
      return;
    }
    if (msg.type === "response" && typeof msg.id === "string") {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
        return;
      }
    }
    if (msg.type === "extension_ui_request") {
      this.answerUiRequest(msg);
      return;
    }
    this.hooks.onMessage(msg);
  }

  /**
   * 后台任务没有真人应答弹窗（例如项目信任确认）。
   * 默认一律取消，避免子进程卡住；配置 AUTO_APPROVE_DIALOGS 时改为同意。
   */
  private answerUiRequest(msg: Record<string, any>): void {
    const method = msg.method;
    if (method === "confirm") {
      this.send({ type: "extension_ui_response", id: msg.id, confirmed: AUTO_APPROVE_DIALOGS });
      return;
    }
    if (method === "select" || method === "input" || method === "editor") {
      this.send({ type: "extension_ui_response", id: msg.id, cancelled: true });
      return;
    }
    // notify / setStatus / setWidget / setTitle / set_editor_text：无需响应
  }

  send(message: Record<string, any>): void {
    if (this.exited || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // 子进程已退出，忽略
    }
  }

  /** 发一条命令并等待带 id 的 response（超时返回 undefined）。 */
  request(message: Record<string, any>, timeoutMs = 5000): Promise<Record<string, any> | undefined> {
    const id = `ws-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ ...message, id });
    });
  }

  /** 优雅终止：先 SIGTERM，宽限 1.5s 后 SIGKILL。 */
  kill(): void {
    if (this.exited) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // 已退出
    }
    this.killTimer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    }, 1500);
    this.killTimer.unref?.();
  }
}

/** 后台任务管理器：创建 / 查询 / 中止 / 清理。 */
export class BackgroundJobManager {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly clients = new Map<string, RpcClient>();
  /** 单监听器：扩展实例可能因 /reload、切会话而重建，每次重建时覆盖即可，避免重复通知。 */
  private listener?: JobListener;
  private readonly maxJobs: number;

  constructor(maxJobs: number = MAX_JOBS) {
    this.maxJobs = maxJobs;
  }

  /** 设置（覆盖）任务状态监听器。 */
  setListener(listener: JobListener | undefined): void {
    this.listener = listener;
  }

  /** 全部任务，按创建时间升序。 */
  list(): BackgroundJob[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /** 还在跑（含等待中）的任务数。 */
  activeCount(): number {
    return this.list().filter((job) => job.status === "starting" || job.status === "running" || job.status === "idle").length;
  }

  /** 真正在跑（agent 正在干活）的任务数。 */
  busyCount(): number {
    return this.list().filter((job) => job.status === "starting" || job.status === "running").length;
  }

  private emit(job: BackgroundJob, update: JobUpdate): void {
    job.updatedAt = Date.now();
    if (job.lastText.length > PREVIEW_CHARS) job.lastText = tail(job.lastText);
    try {
      this.listener?.(job, update);
    } catch {
      // 监听器异常不影响任务
    }
  }

  start(opts: StartJobOptions): BackgroundJob {
    const active = this.list().filter((job) => job.status !== "exited" && job.status !== "failed");
    if (active.length >= this.maxJobs) {
      throw new Error(`后台任务已达上限 ${this.maxJobs} 个，请先到 /wsj 里结束一些任务`);
    }

    const job: BackgroundJob = {
      id: randomUUID().slice(0, 8),
      cwd: opts.cwd,
      title: opts.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "starting",
      sessionFile: opts.sessionFile,
      model: opts.model,
      prompt: opts.prompt,
      lastText: "",
      streamingText: "",
      turns: 0,
      stderrTail: "",
      unread: false,
    };
    this.jobs.set(job.id, job);

    const client = new RpcClient(opts.piBinary || PI_BINARY, buildArgs(opts), opts.cwd, {
      onMessage: (msg) => this.handleEvent(job, msg),
      onStderr: (chunk) => {
        const cleaned = cleanStderr(chunk);
        if (cleaned) job.stderrTail = tail(`${job.stderrTail}${job.stderrTail ? "\n" : ""}${cleaned}`, 800);
      },
      onExit: (code, signal) => {
        job.exitCode = code;
        job.exitSignal = signal;
        if (job.status !== "failed" && job.status !== "exited") {
          job.status = code === 0 ? "exited" : "failed";
          if (code !== 0 && !job.error) {
            job.error = `后台 pi 进程退出（code=${code ?? "-"}${signal ? `, signal=${signal}` : ""}）`;
          }
        }
        this.clients.delete(job.id);
        this.emit(job, { kind: "exited" });
      },
      onError: (error) => {
        job.status = "failed";
        job.error = `无法启动后台 pi：${error.message}`;
        this.emit(job, { kind: "failed", message: job.error });
      },
    });
    this.clients.set(job.id, client);
    this.emit(job, { kind: "started" });

    // 立即投喂首个指令：stdin 管道会缓冲，pi 启动后即可读到
    client.send({ type: "prompt", message: opts.prompt, id: `ws-prompt-${job.id}` });
    this.emit(job, { kind: "running" });
    return job;
  }

  /** 往已有任务追加指令（运行中则排队）。 */
  send(jobId: string, text: string): boolean {
    const job = this.jobs.get(jobId);
    const client = this.clients.get(jobId);
    if (!job || !client) return false;
    const streaming = job.status === "starting" || job.status === "running";
    client.send({ type: "prompt", message: text, ...(streaming ? { streamingBehavior: "followUp" } : {}) });
    if (!streaming) {
      job.status = "running";
      this.emit(job, { kind: "running" });
    }
    return true;
  }

  /** 中止当前这轮 agent 执行（会话保留，可继续对话）。 */
  abort(jobId: string): boolean {
    const client = this.clients.get(jobId);
    if (!client) return false;
    client.send({ type: "abort" });
    return true;
  }

  /** 结束任务并杀掉子进程。 */
  stop(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    const client = this.clients.get(jobId);
    if (!job) return false;
    if (client) client.kill();
    job.status = "exited";
    this.emit(job, { kind: "exited" });
    return true;
  }

  stopAll(): void {
    for (const job of this.list()) {
      if (job.status === "exited" || job.status === "failed") continue;
      this.stop(job.id);
    }
  }

  /** 从列表里移除任务（前提是已经结束）。 */
  remove(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status !== "exited" && job.status !== "failed") return false;
    this.jobs.delete(jobId);
    return true;
  }

  /** 清理所有已结束任务。 */
  clearFinished(): number {
    let removed = 0;
    for (const job of this.list()) {
      if (job.status === "exited" || job.status === "failed") {
        this.jobs.delete(job.id);
        removed += 1;
      }
    }
    return removed;
  }

  /** 从 RPC 事件更新任务状态。 */
  private handleEvent(job: BackgroundJob, msg: Record<string, any>): void {
    switch (msg.type) {
      case "agent_start":
        job.status = "running";
        job.streamingText = "";
        job.error = undefined;
        this.emit(job, { kind: "running" });
        return;

      case "message_update": {
        // 流式增量：text_delta 逐块拼接，text_end 给出最终文本
        const evt = msg.assistantMessageEvent;
        if (!evt || typeof evt !== "object") return;
        if (evt.type === "text_start") {
          job.streamingText = "";
        } else if (evt.type === "text_delta" && typeof evt.delta === "string") {
          job.streamingText += evt.delta;
        } else if (evt.type === "text_end" && typeof evt.content === "string") {
          job.streamingText = evt.content;
        } else if (evt.type === "toolcall_start" && typeof evt.toolName === "string") {
          job.lastTool = evt.toolName;
        }
        return;
      }

      case "message_end": {
        const message = msg.message;
        if (!message || message.role !== "assistant") return;
        const text = assistantText(message);
        if (text) {
          job.lastText = text;
          job.streamingText = "";
        }
        if (message.stopReason === "error" && message.errorMessage) {
          job.error = String(message.errorMessage);
        }
        this.emit(job, { kind: "assistant", text: job.lastText });
        return;
      }

      case "tool_execution_start":
        job.lastTool = typeof msg.toolName === "string" ? msg.toolName : undefined;
        this.emit(job, { kind: "tool", tool: job.lastTool || "tool" });
        return;

      case "turn_end":
        job.turns += 1;
        return;

      case "agent_settled":
        job.status = job.error ? "failed" : "idle";
        job.streamingText = "";
        job.unread = true;
        void this.captureSessionFile(job);
        this.emit(job, job.error ? { kind: "failed", message: job.error } : { kind: "settled" });
        return;

      case "extension_error":
        job.stderrTail = tail(`${job.stderrTail}\n[extension] ${msg.error ?? "unknown"}`, 800);
        return;

      default:
        return;
    }
  }

  /** 新任务的会话文件由子进程创建，问它要一下，方便之后切入。 */
  private async captureSessionFile(job: BackgroundJob): Promise<void> {
    if (job.sessionFile) return;
    const client = this.clients.get(job.id);
    if (!client) return;
    const response = await client.request({ type: "get_session_stats" });
    const file = response?.data?.sessionFile;
    if (typeof file === "string" && file) {
      job.sessionFile = file;
      this.emit(job, { kind: "running" });
    }
  }
}
