/**
 * workspace-switcher —— 交互流程
 *
 * 三个界面：
 *   1. 目录选择    `/ws` 第一层：所有项目目录 + 新目录 + 后台任务入口
 *   2. 会话选择    某个目录下的会话列表 + 新开会话 / 后台任务
 *   3. 后台任务    `/wsj`：查看、继续、中止、切入后台任务
 *
 * 逐层 select，Esc / 选「返回」回上一层，选「关闭」退出。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { INHERIT_MODEL } from "./config";
import type { BackgroundJob, BackgroundJobManager } from "./jobs";
import {
  collectDirs,
  collectSessions,
  createEmptySessionFile,
  dirLabel,
  resolveDir,
  sessionLabel,
  sessionOptionLabel,
  shortPath,
  singleLine,
} from "./sessions";
import { getLastDir, setLastDir } from "./state";

const BACK = "🔙 返回";
const CLOSE = "✖ 关闭";
const INPUT_DIR = "➕ 输入目录路径…";
const NEW_SESSION = "➕ 在此目录新开会话（切换过去）";
const NEW_JOB = "🚀 在此目录新开后台任务…";
const JOBS_ENTRY = "🛰 后台任务";

/** 取当前模型标识，给后台任务继承。 */
function currentModel(ctx: ExtensionCommandContext): string | undefined {
  if (!INHERIT_MODEL) return undefined;
  const model = ctx.model;
  if (!model) return undefined;
  const provider = (model as { provider?: string }).provider;
  const id = (model as { id?: string }).id;
  if (!provider || !id) return undefined;
  return `${provider}/${id}`;
}

/** 在给定候选里匹配用户选中的 label，返回下标。 */
function indexOfChoice(options: string[], picked: string | undefined): number {
  if (picked === undefined) return -1;
  return options.indexOf(picked);
}

/**
 * 在目标目录开一个全新的前台会话并切换过去。
 *
 * 扩展 API 不能直接改 cwd，但 runtime 会跟随会话 header 的 cwd：
 * 先落一个带 header 的空会话文件，再切过去，cwd 就跟着走了。
 */
async function switchToNewSession(ctx: ExtensionCommandContext, rawDir: string): Promise<void> {
  const dir = resolveDir(rawDir);
  let file: string;
  try {
    file = createEmptySessionFile(dir);
  } catch (error) {
    ctx.ui.notify(`创建会话失败：${(error as Error).message}`, "error");
    return;
  }

  if (!(await ensureIdleBeforeSwitch(ctx, `即将在 ${shortPath(dir)} 新开会话`))) return;

  // switchSession 之后旧 ctx 会失效（pi 会报 stale），提示必须放进 withSession 用新 ctx
  const result = await ctx.switchSession(file, {
    withSession: async (next) => {
      next.ui.notify(`已进入 ${shortPath(dir)}，这是一个新会话`, "info");
    },
  });
  if (result.cancelled) return;
}

/** 切走之前提醒正在跑的任务会被中断。 */
async function ensureIdleBeforeSwitch(ctx: ExtensionCommandContext, what: string): Promise<boolean> {
  if (ctx.isIdle()) return true;
  return ctx.ui.confirm("当前会话正在执行", `${what}。切换会中断当前正在跑的回复/工具，继续？`);
}

/** 起一个后台任务。 */
function startJob(
  ctx: ExtensionCommandContext,
  manager: BackgroundJobManager,
  opts: { cwd: string; title: string; prompt: string; sessionFile?: string },
): void {
  // 同一个会话文件被主 TUI 和后台进程同时写会互相覆盖，直接拦住
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (opts.sessionFile && currentSessionFile && opts.sessionFile === currentSessionFile) {
    ctx.ui.notify("这是当前打开的会话：后台跑会和主界面抢同一个会话文件。请先 /new 切到别的会话，或改在其它会话上后台跑。", "warning");
    return;
  }

  try {
    const job = manager.start({ ...opts, model: currentModel(ctx) });
    ctx.ui.notify(`🛰 后台任务已启动 [${job.id}]：${opts.title}\n运行目录：${shortPath(opts.cwd)}`, "info");
  } catch (error) {
    ctx.ui.notify(`启动后台任务失败：${(error as Error).message}`, "error");
  }
}

/** 单个会话上的可选动作。 */
async function pickSessionAction(
  ctx: ExtensionCommandContext,
  manager: BackgroundJobManager,
  session: { path: string; cwd: string; label: string },
): Promise<"back" | "done"> {
  const options = ["👁 切换到此会话", "🚀 后台继续跑（输入指令）", "📄 查看会话信息", BACK];
  const picked = await ctx.ui.select(`会话：${session.label}`, options);
  const index = indexOfChoice(options, picked);

  if (index < 0 || picked === BACK) return "back";

  if (picked === "📄 查看会话信息") {
    await ctx.ui.editor(
      "会话信息（Esc 关闭）",
      [`会话：${session.label}`, `目录：${session.cwd}`, `文件：${session.path}`].join("\n"),
    );
    return "back";
  }

  if (picked === "👁 切换到此会话") {
    if (!(await ensureIdleBeforeSwitch(ctx, `即将切到会话「${session.label}」`))) return "back";
    const result = await ctx.switchSession(session.path, {
      withSession: async (next) => {
        next.ui.notify(`已切到会话「${session.label}」`, "info");
      },
    });
    if (result.cancelled) return "back";
    return "done";
  }

  if (picked === "🚀 后台继续跑（输入指令）") {
    const prompt = await ctx.ui.input("给这个会话下一条指令", "例如：继续把剩下的用例补完");
    if (!prompt?.trim()) return "back";
    startJob(ctx, manager, {
      cwd: session.cwd,
      title: session.label,
      prompt: prompt.trim(),
      sessionFile: session.path,
    });
    return "done";
  }

  return "back";
}

/** 第二层：某个目录下的会话列表。 */
async function openDir(
  ctx: ExtensionCommandContext,
  manager: BackgroundJobManager,
  dir: string,
): Promise<"back" | "done"> {
  const currentFile = ctx.sessionManager.getSessionFile();

  for (;;) {
    const sessions = await collectSessions(dir);
    const options = [NEW_SESSION, NEW_JOB, ...sessions.map((info) => sessionOptionLabel(info, info.path === currentFile)), BACK];
    const picked = await ctx.ui.select(`目录：${shortPath(dir)}`, options);
    const index = indexOfChoice(options, picked);

    if (index < 0 || picked === BACK) return "back";

    if (picked === NEW_SESSION) {
      await switchToNewSession(ctx, dir);
      return "done";
    }

    if (picked === NEW_JOB) {
      const prompt = await ctx.ui.input(`在 ${shortPath(dir)} 新开一个后台任务`, "描述要它做的事，回车启动");
      if (!prompt?.trim()) return "back";
      startJob(ctx, manager, {
        cwd: dir,
        title: `${shortPath(dir)} 新任务`,
        prompt: prompt.trim(),
      });
      return "done";
    }

    const sessionIndex = index - 2;
    const info = sessions[sessionIndex];
    if (!info) return "back";
    const action = await pickSessionAction(ctx, manager, {
      path: info.path,
      cwd: info.cwd || dir,
      label: sessionLabel(info),
    });
    if (action === "done") return "done";
  }
}

/** 第一层：工作区切换器主入口。 */
export async function openWorkspaceSwitcher(
  ctx: ExtensionCommandContext,
  manager: BackgroundJobManager,
  startDir?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/ws 需要交互界面（TUI 或 RPC 模式）", "error");
    return;
  }

  if (startDir?.trim()) {
    const dir = resolveDir(startDir.trim());
    setLastDir(dir);
    await openDir(ctx, manager, dir);
    return;
  }

  for (;;) {
    const dirs = await collectDirs();
    const last = getLastDir();
    const jobCount = manager.activeCount();
    const options = [
      ...dirs.map(dirLabel),
      ...(last && !dirs.some((d) => d.cwd === last) ? [`📁 ${shortPath(last)}（上次使用）`] : []),
      INPUT_DIR,
      `${JOBS_ENTRY}（${jobCount} 个在跑）`,
      CLOSE,
    ];
    const picked = await ctx.ui.select("工作区：选择目录", options);

    if (picked === undefined || picked === CLOSE) return;

    if (picked === INPUT_DIR) {
      const input = await ctx.ui.input("目录路径", "支持 ~/ 开头，例如 ~/work/demo");
      const raw = input?.trim();
      if (!raw) continue;
      const dir = resolveDir(raw);
      setLastDir(dir);
      const action = await openDir(ctx, manager, dir);
      if (action === "done") return;
      continue;
    }

    if (picked.startsWith(JOBS_ENTRY)) {
      const action = await openJobsPanel(ctx, manager);
      if (action === "done") return;
      continue;
    }

    const index = dirs.findIndex((node) => dirLabel(node) === picked);
    const dir = index >= 0 ? dirs[index].cwd : last;
    if (!dir) continue;
    setLastDir(dir);
    const action = await openDir(ctx, manager, dir);
    if (action === "done") return;
  }
}

const STATUS_ICON: Record<BackgroundJob["status"], string> = {
  starting: "◌",
  running: "●",
  idle: "○",
  exited: "■",
  failed: "✖",
};

const STATUS_TEXT: Record<BackgroundJob["status"], string> = {
  starting: "启动中",
  running: "跑中",
  idle: "空闲（可继续对话）",
  exited: "已结束",
  failed: "失败",
};

/** 后台任务列表里的一项。 */
function jobLabel(job: BackgroundJob): string {
  const icon = STATUS_ICON[job.status];
  const suffix = job.unread ? "  ·  🆕" : "";
  return `${icon} [${job.id}] ${job.title}  ·  ${shortPath(job.cwd)}  ·  ${STATUS_TEXT[job.status]}${suffix}`;
}

/** 任务输出预览文本。 */
function jobPreview(job: BackgroundJob): string {
  const lines = [
    `任务 [${job.id}] ${job.title}`,
    `目录：${job.cwd}`,
    `会话：${job.sessionFile || "(尚未落盘)"}`,
    `状态：${STATUS_TEXT[job.status]}`,
    `轮次：${job.turns} 次`,
    `最近工具：${job.lastTool || "-"}`,
    `首个指令：${job.prompt ? singleLine(job.prompt, 120) : "-"}`,
    "",
    "—— 最近输出 ——",
    job.streamingText || job.lastText || "(暂无输出)",
  ];
  if (job.error) lines.push("", `—— 错误 ——`, job.error);
  if (job.stderrTail) lines.push("", "—— stderr ——", job.stderrTail);
  return lines.join("\n");
}

/** 第三层：后台任务面板。 */
export async function openJobsPanel(ctx: ExtensionCommandContext, manager: BackgroundJobManager): Promise<"back" | "done"> {
  for (;;) {
    const jobs = manager.list();
    const options = [
      ...jobs.map(jobLabel),
      ...(jobs.some((job) => job.status === "exited" || job.status === "failed") ? ["🧹 清理已结束任务"] : []),
      BACK,
    ];
    const picked = await ctx.ui.select("后台任务", options);
    const index = indexOfChoice(options, picked);

    if (index < 0 || picked === BACK) return "back";

    if (picked === "🧹 清理已结束任务") {
      const removed = manager.clearFinished();
      ctx.ui.notify(`已清理 ${removed} 个已结束任务`, "info");
      continue;
    }

    const job = jobs[index];
    if (!job) continue;
    job.unread = false;
    const action = await pickJobAction(ctx, manager, job);
    if (action === "done") return "done";
  }
}

/** 单个后台任务上的动作。 */
async function pickJobAction(
  ctx: ExtensionCommandContext,
  manager: BackgroundJobManager,
  job: BackgroundJob,
): Promise<"back" | "done"> {
  const live = job.status !== "exited" && job.status !== "failed";
  const options = [
    "📄 查看最近输出",
    ...(live ? ["💬 继续对话（追加指令）", "⏹ 中止当前这轮", "🛑 结束任务"] : []),
    ...(job.sessionFile ? ["👁 切入这个会话（结束后台后切换）"] : []),
    BACK,
  ];
  const picked = await ctx.ui.select(`任务 [${job.id}] ${job.title}`, options);
  if (picked === undefined || picked === BACK) return "back";

  if (picked === "📄 查看最近输出") {
    await ctx.ui.editor("后台任务输出（Esc 关闭）", jobPreview(job));
    return "back";
  }

  if (picked === "💬 继续对话（追加指令）") {
    const prompt = await ctx.ui.input("追加指令", "回车发送（任务在跑则排队）");
    if (!prompt?.trim()) return "back";
    manager.send(job.id, prompt.trim());
    ctx.ui.notify(`已发往任务 [${job.id}]`, "info");
    return "back";
  }

  if (picked === "⏹ 中止当前这轮") {
    manager.abort(job.id);
    ctx.ui.notify(`已请求中止任务 [${job.id}] 当前这轮`, "warning");
    return "back";
  }

  if (picked === "🛑 结束任务") {
    const ok = await ctx.ui.confirm("结束后台任务", `确定结束任务 [${job.id}] ${job.title}？未完成的回合会被终止。`);
    if (!ok) return "back";
    manager.stop(job.id);
    ctx.ui.notify(`任务 [${job.id}] 已结束`, "info");
    return "back";
  }

  if (picked === "👁 切入这个会话（结束后台后切换）") {
    const file = job.sessionFile;
    if (!file) return "back";
    if (job.status !== "exited" && job.status !== "failed") {
      const ok = await ctx.ui.confirm("切入会话", "切入前会结束这个后台任务（避免两个进程同时写同一个会话文件）。继续？");
      if (!ok) return "back";
      manager.stop(job.id);
      // 给子进程一点时间落盘
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!(await ensureIdleBeforeSwitch(ctx, `即将切到后台任务的会话「${job.title}」`))) return "back";
    const result = await ctx.switchSession(file, {
      withSession: async (next) => {
        next.ui.notify(`已切入任务 [${job.id}] 的会话`, "info");
      },
    });
    if (result.cancelled) return "back";
    return "done";
  }

  return "back";
}
