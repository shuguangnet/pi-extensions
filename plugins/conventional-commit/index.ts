/**
 * conventional-commit —— pi Conventional Commits 助手
 *
 * 两个能力：
 *   1. `/commit` 命令：交互式生成并执行符合 Conventional Commits 的提交
 *      （选类型 → 可选作用域 → 中文描述 → 确认 → git commit）
 *   2. 校验钩子：拦截 `bash` 里的 `git commit -m "..."`，若消息不符合
 *      Conventional Commits 格式，弹窗让用户确认是否仍要提交（默认阻止）。
 *
 * 安装 / 使用见本插件 README.md 与仓库根 README.md。
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Conventional Commits 允许的类型。 */
const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

/** 校验一条提交消息是否符合 Conventional Commits 格式。 */
const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+/;

function isValidConventional(message: string): boolean {
  return CONVENTIONAL_RE.test(message.trim());
}

/** 在指定目录执行 git 命令，返回 stdout（去尾空白）。 */
async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const r = await pi.exec("git", args, { cwd });
  return r.stdout.trim();
}

/** 从一条 bash 命令里提取 `git commit -m "..."` 的提交消息。 */
function extractCommitMessage(command: string): string | null {
  // 优先匹配带引号：-m "..." / -m '...'
  const quoted = command.match(/-m\s+["']([^"']+)["']/);
  if (quoted) return quoted[1];
  // 兜底：-m 后跟一个非空白 token
  const bare = command.match(/-m\s+(\S+)/);
  if (bare) return bare[1];
  return null;
}

/** 判断一条 bash 命令是否在跑 git commit。 */
function isGitCommit(command: string): boolean {
  return /\bgit\s+commit\b/.test(command);
}

export default function (pi: ExtensionAPI) {
  // ---- 能力 1：/commit 交互式提交 ----
  pi.registerCommand("commit", {
    description: "按 Conventional Commits 交互式创建提交（选类型/作用域/中文描述）",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/commit 需要交互界面", "warning");
        return;
      }
      const cwd = ctx.cwd;

      // 1. 确认是 git 仓库
      try {
        await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
      } catch {
        ctx.ui.notify("当前目录不是 git 仓库", "error");
        return;
      }

      // 2. 检查已暂存改动
      let staged = "";
      try {
        staged = await git(pi, cwd, ["diff", "--cached", "--stat"]);
      } catch {
        /* 忽略 */
      }
      if (!staged) {
        ctx.ui.notify("没有已暂存(staged)的改动，请先 git add", "warning");
        return;
      }
      ctx.ui.notify(`已暂存改动：\n${staged}`, "info");

      // 3. 选类型
      const type = await ctx.ui.select("提交类型", [...COMMIT_TYPES]);
      if (!type) return;

      // 4. 可选作用域
      const scope = await ctx.ui.input("作用域（可选，如 api / order）", "留空则无作用域");
      if (scope === undefined) return;

      // 5. 中文描述
      const desc = await ctx.ui.input("提交描述（中文）", "例如：修复登录 401 跳转");
      if (!desc) return;

      const scopePart = scope.trim() ? `(${scope.trim()})` : "";
      const message = `${type}${scopePart}: ${desc.trim()}`;

      // 6. 确认并提交
      const ok = await ctx.ui.confirm("确认提交", `git commit -m "${message}"`);
      if (!ok) {
        ctx.ui.notify("已取消", "info");
        return;
      }
      try {
        await git(pi, cwd, ["commit", "-m", message]);
        ctx.ui.notify("提交成功", "info");
      } catch (e: any) {
        ctx.ui.notify(`提交失败：${e?.message ?? e}`, "error");
      }
    },
  });

  // ---- 能力 2：校验 git commit 消息格式 ----
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = String(event.input.command ?? "");
    if (!isGitCommit(command)) return undefined;

    const message = extractCommitMessage(command);
    // 没有 -m（例如 git commit 打开编辑器）不拦截
    if (message === null) return undefined;

    if (isValidConventional(message)) return undefined;

    // 格式不符合：无交互界面默认阻止；有界面则让用户决定
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `提交消息不符合 Conventional Commits 格式（无交互界面，默认阻止）: ${message}`,
      };
    }

    const choice = await ctx.ui.select(
      `⚠️ 提交消息不符合 Conventional Commits 格式：\n\n  ${message}\n\n仍要提交吗？`,
      ["仍要提交", "取消"],
    );
    if (choice !== "仍要提交") {
      return { block: true, reason: `提交消息格式不符合，已由用户取消: ${message}` };
    }
    return undefined;
  });
}
