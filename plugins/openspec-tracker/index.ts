/**
 * openspec-tracker —— pi OpenSpec 变更状态提醒
 *
 * 在会话启动时检查当前项目 `openspec/changes/` 下有没有"已实现但未归档"的变更
 * （tasks.md 全部勾选 = 已实现），有则提醒运行 `/opsx-archive` 收尾，
 * 避免变更堆积。
 *
 * 另提供 `/opsx-status` 命令手动查看。
 *
 * 安装 / 使用见本插件 README.md 与仓库根 README.md。
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { OPENSPEC_DIR, CHANGES_DIR, TASKS_FILE, REMIND_ON } from "./config";

/** 简单路径拼接（避免依赖 node path）。 */
function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** 从 cwd 向上查找 openspec 根目录，找不到返回 null。 */
async function findOpenspecRoot(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  let dir = cwd;
  for (let i = 0; i < 10; i += 1) {
    const candidate = joinPath(dir, OPENSPEC_DIR);
    const r = await pi.exec("ls", ["-d", candidate]);
    if (r.code === 0) return candidate;
    const parent = dir.split("/").slice(0, -1).join("/");
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 列出 openspec/changes 下的变更名。 */
async function listChanges(pi: ExtensionAPI, root: string): Promise<string[]> {
  const r = await pi.exec("ls", ["-1", joinPath(root, CHANGES_DIR)]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s: string) => s.trim())
    .filter(Boolean);
}

/** 判断一个变更是否"已实现"（tasks.md 存在且无未勾选任务）。 */
async function isImplemented(
  pi: ExtensionAPI,
  root: string,
  change: string,
): Promise<boolean> {
  const tasksPath = joinPath(root, CHANGES_DIR, change, TASKS_FILE);
  const r = await pi.exec("cat", [tasksPath]);
  if (r.code !== 0) return false; // 没有 tasks.md，视为未实现
  // 存在未勾选任务（- [ ]）则未实现
  return !/-\s*\[\s*\]/.test(r.stdout);
}

/** 收集"已实现但未归档"的变更名。 */
async function collectDoneChanges(
  pi: ExtensionAPI,
  root: string,
): Promise<string[]> {
  const changes = await listChanges(pi, root);
  const done: string[] = [];
  for (const change of changes) {
    if (await isImplemented(pi, root, change)) done.push(change);
  }
  return done;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    if (!REMIND_ON.includes(event.reason)) return;
    if (!ctx.hasUI) return;

    const root = await findOpenspecRoot(pi, ctx.cwd);
    if (!root) return;

    const done = await collectDoneChanges(pi, root);
    if (done.length === 0) return;

    ctx.ui.notify(
      `检测到 ${done.length} 个已实现但未归档的 OpenSpec 变更：\n${done.join("\n")}\n\n可运行 /opsx-archive 归档`,
      "warning",
    );
  });

  // 手动查看
  pi.registerCommand("opsx-status", {
    description: "列出已实现但未归档的 OpenSpec 变更",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const root = await findOpenspecRoot(pi, ctx.cwd);
      if (!root) {
        ctx.ui.notify("当前目录未找到 openspec/ 目录", "info");
        return;
      }
      const done = await collectDoneChanges(pi, root);
      if (done.length === 0) {
        ctx.ui.notify("没有已实现但未归档的变更", "info");
        return;
      }
      ctx.ui.notify(
        `已实现但未归档：\n${done.join("\n")}\n\n可运行 /opsx-archive 归档`,
        "warning",
      );
    },
  });
}
