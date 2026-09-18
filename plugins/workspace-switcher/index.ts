/**
 * workspace-switcher —— 跨目录会话切换 + 后台并行对话
 *
 * 解决两件事：
 *   1. 在 pi 里直接换工作目录：浏览所有项目的会话，恢复 / 新开，不用退出重进。
 *   2. 让对话在后台继续跑：把任务交给独立的 `pi --mode rpc` 子进程，
 *      主 TUI 随便切目录、切会话都不会打断它；跑完会通知，随时可切入接管。
 *
 * 命令：
 *   /ws            工作区切换器（目录 → 会话 → 恢复 / 新开 / 后台跑）
 *   /ws <目录>     直接进入指定目录
 *   /wsj           后台任务面板（查看输出 / 追加指令 / 中止 / 结束 / 切入）
 *
 * 安装 / 自定义见本插件 README.md 与仓库根 README.md。
 */

import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

import { getManager, getUiContext, setUiContext } from "./state";
import { openJobsPanel, openWorkspaceSwitcher } from "./ui";

const STATUS_KEY = "ws-jobs";

export default function (pi: ExtensionAPI) {
  const manager = getManager();

  /** 状态栏：在跑 / 空闲的任务数。 */
  const syncStatus = (): void => {
    const ctx = getUiContext();
    if (!ctx?.hasUI) return;
    const active = manager.activeCount();
    if (active === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const busy = manager.busyCount();
    const idle = active - busy;
    ctx.ui.setStatus(STATUS_KEY, `🛰 ${busy} 跑中${idle > 0 ? ` · ${idle} 空闲` : ""}`);
  };

  // 覆盖式监听：/reload 或切换会话后扩展实例会重建，重新设置即可，不会重复通知
  manager.setListener((job, update) => {
    syncStatus();
    const ctx = getUiContext();
    if (!ctx?.hasUI) return;
    try {
      if (update.kind === "settled") {
        ctx.ui.notify(`✅ 后台任务 [${job.id}] 完成：${job.title}（/wsj 查看输出）`, "info");
      } else if (update.kind === "failed") {
        ctx.ui.notify(`✖ 后台任务 [${job.id}] 失败：${job.error ?? "未知错误"}（/wsj 查看详情）`, "error");
      }
    } catch {
      // UI 已失效（会话替换等），忽略
    }
  });

  pi.on("session_start", (_event, ctx) => {
    setUiContext(ctx);
    syncStatus();
  });

  pi.registerCommand("ws", {
    description: "工作区切换器：跨目录浏览/恢复/新开会话，或把任务丢到后台跑（/ws <目录> 直接进入）",
    handler: async (args, ctx) => {
      setUiContext(ctx);
      await openWorkspaceSwitcher(ctx, manager, args);
      syncStatus();
    },
  });

  pi.registerCommand("wsj", {
    description: "后台任务面板：查看输出、追加指令、中止、结束、切入会话",
    handler: async (_args, ctx) => {
      setUiContext(ctx);
      await openJobsPanel(ctx, manager);
      syncStatus();
    },
  });

  pi.on("session_shutdown", (event: SessionShutdownEvent) => {
    // 只有真正退出才清理后台任务；reload / 切换会话都要让它们继续跑
    if (event.reason === "quit") manager.stopAll();
  });
}
