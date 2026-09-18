/**
 * workspace-switcher —— 进程级单例状态
 *
 * 后台任务是子进程，不能因为 `/reload`、切换会话而丢引用（否则会变成孤儿进程）。
 * 因此把管理器挂到 globalThis（同一 pi 进程内跨扩展实例复用）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { BackgroundJobManager } from "./jobs";
import type { DirNode } from "./sessions";

const KEY = Symbol.for("pi-workspace-switcher/state");

interface WorkspaceState {
  manager: BackgroundJobManager;
  dirCache?: { at: number; dirs: DirNode[] };
  /** 最近一次打开面板用的目录，作为下次默认项。 */
  lastDir?: string;
  /**
   * 最新的扩展上下文。
   * 扩展实例会在 /reload、切换会话时重建，旧闭包里的 ctx 会失效；
   * 所以统一放在全局，后台任务的回调总能拿到当前有效的 ctx。
   */
  uiCtx?: ExtensionContext;
}

function state(): WorkspaceState {
  const store = globalThis as unknown as Record<symbol, WorkspaceState | undefined>;
  let current = store[KEY];
  if (!current) {
    current = { manager: new BackgroundJobManager() };
    store[KEY] = current;
  }
  return current;
}

export function getManager(): BackgroundJobManager {
  return state().manager;
}

export function getDirCache(): { at: number; dirs: DirNode[] } | undefined {
  return state().dirCache;
}

export function setDirCache(dirs: DirNode[]): void {
  state().dirCache = { at: Date.now(), dirs };
}

export function getLastDir(): string | undefined {
  return state().lastDir;
}

export function setLastDir(dir: string): void {
  state().lastDir = dir;
}

/** 记录当前有效的扩展上下文。 */
export function setUiContext(ctx: ExtensionContext | undefined): void {
  state().uiCtx = ctx;
}

/** 取当前有效的扩展上下文（可能为 undefined）。 */
export function getUiContext(): ExtensionContext | undefined {
  return state().uiCtx;
}
