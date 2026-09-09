/**
 * dirty-repo-guard —— pi 脏仓库守卫
 *
 * 在切换 / 新建 / fork / 压缩会话前，检测当前 git 仓库是否有未提交改动；
 * 有则弹窗提醒，防止误清空 / 切换导致丢失未提交的工作。
 *
 * 基于 pi 官方示例 dirty-repo-guard.ts，扩展为可配置（开关各事件 + headless 行为）。
 *
 * 安装 / 使用见本插件 README.md 与仓库根 README.md。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
} from "@earendil-works/pi-coding-agent";

import { GUARD_SWITCH, GUARD_FORK, GUARD_COMPACT, BLOCK_HEADLESS } from "./config";

/**
 * 检查当前目录 git 仓库是否有未提交改动。
 * 有改动时：有界面则询问用户，无界面则按 BLOCK_HEADLESS 决定是否阻止。
 * 返回 `{ cancel: true }` 表示阻止该会话操作。
 */
async function checkDirtyRepo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: string,
): Promise<{ cancel: true } | undefined> {
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);

  // 不是 git 仓库，放行
  if (code !== 0) return undefined;

  const hasChanges = stdout.trim().length > 0;
  if (!hasChanges) return undefined;

  // 无交互界面：按配置决定是否默认阻止
  if (!ctx.hasUI) {
    return BLOCK_HEADLESS ? { cancel: true } : undefined;
  }

  const changedFiles = stdout.trim().split("\n").filter(Boolean).length;
  const choice = await ctx.ui.select(
    `检测到 ${changedFiles} 个未提交文件。${action} 会丢失这些工作，仍要继续吗？`,
    ["先提交再继续", "仍要继续"],
  );

  if (choice !== "仍要继续") {
    ctx.ui.notify("请先提交你的改动", "warning");
    return { cancel: true };
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
    if (!GUARD_SWITCH) return undefined;
    const action = event.reason === "new" ? "新建会话" : "切换会话";
    return checkDirtyRepo(pi, ctx, action);
  });

  pi.on("session_before_fork", async (_event: SessionBeforeForkEvent, ctx: ExtensionContext) => {
    if (!GUARD_FORK) return undefined;
    return checkDirtyRepo(pi, ctx, "fork 会话");
  });

  pi.on("session_before_compact", async (_event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    if (!GUARD_COMPACT) return undefined;
    return checkDirtyRepo(pi, ctx, "压缩会话");
  });
}
