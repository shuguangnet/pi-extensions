/**
 * workspace-switcher —— 跨目录会话索引
 *
 * 目录与会话都来自 pi 的 SessionManager：
 *   - `SessionManager.listAll()` 列出所有项目的会话（用于汇总目录）
 *   - `SessionManager.list(cwd)` 列出某个目录的会话
 * 结果做短时缓存，避免每次打开面板都全量扫盘。
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

import { LIST_CACHE_MS, MAX_DIRS, MAX_SESSIONS_PER_DIR } from "./config";
import { getDirCache, setDirCache } from "./state";

/** 目录节点：一个工作目录 + 它的会话数量与最近活动时间。 */
export interface DirNode {
  cwd: string;
  count: number;
  /** 最近一次会话活动时间戳。 */
  modified: number;
  /** 目录当前是否还存在（被删掉的项目仍能从会话里看到）。 */
  alive: boolean;
}

/** 把绝对路径缩写成 ~/… 形式，方便在窄列表里展示。 */
export function shortPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** 相对时间文案。 */
export function relativeTime(value: Date | number): string {
  const ts = typeof value === "number" ? value : value.getTime();
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/** 单行截断。 */
export function singleLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 会话展示名：用户命名 > 首条消息 > 短 id。 */
export function sessionLabel(info: SessionInfo): string {
  if (info.name) return singleLine(info.name, 60);
  if (info.firstMessage) return singleLine(info.firstMessage, 60);
  return `未命名会话 ${info.id.slice(0, 8)}`;
}

/** 展开 ~ 并解析成真实路径（与 pi 启动时的 process.cwd() 保持一致，避免同一目录出现两份会话目录）。 */
export function resolveDir(input: string): string {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? `${homedir()}${input.slice(1)}`
        : input;
  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

/**
 * 在目标目录预置一个合法的空会话文件（只有 header）。
 *
 * 为什么要自己写：pi 的 SessionManager 对「还没有 assistant 消息」的会话是不落盘的，
 * 而扩展 API 里没有直接改 cwd 的入口 —— runtime 只能通过会话 header 里的 cwd 跟着走。
 * 所以先落一个 header，再 switchSession 过去，cwd 就落在目标目录了。
 */
export function createEmptySessionFile(cwd: string): string {
  const manager = SessionManager.create(cwd);
  const file = manager.getSessionFile();
  if (!file) throw new Error("拿不到会话文件路径");
  mkdirSync(dirname(file), { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id: manager.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return file;
}

/** 汇总所有项目目录（带缓存）。 */
export async function collectDirs(force = false): Promise<DirNode[]> {
  const cached = getDirCache();
  if (!force && cached && Date.now() - cached.at < LIST_CACHE_MS) {
    return cached.dirs;
  }

  let sessions: SessionInfo[] = [];
  try {
    sessions = await SessionManager.listAll();
  } catch {
    sessions = [];
  }

  const byCwd = new Map<string, DirNode>();
  for (const info of sessions) {
    const cwd = info.cwd?.trim();
    if (!cwd) continue;
    const node = byCwd.get(cwd);
    const modified = info.modified?.getTime?.() ?? 0;
    if (node) {
      node.count += 1;
      node.modified = Math.max(node.modified, modified);
    } else {
      byCwd.set(cwd, { cwd, count: 1, modified, alive: existsSync(cwd) });
    }
  }

  const dirs = [...byCwd.values()].sort((a, b) => b.modified - a.modified).slice(0, MAX_DIRS);
  setDirCache(dirs);
  return dirs;
}

/** 某个目录下的会话（按最近活动排序）。 */
export async function collectSessions(cwd: string): Promise<SessionInfo[]> {
  let sessions: SessionInfo[] = [];
  try {
    sessions = await SessionManager.list(cwd);
  } catch {
    sessions = [];
  }
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, MAX_SESSIONS_PER_DIR);
}

/** 目录项的展示文案。 */
export function dirLabel(node: DirNode): string {
  const flag = node.alive ? "" : "（目录已不存在）";
  return `📁 ${shortPath(node.cwd)}  ·  ${node.count} 个会话  ·  ${relativeTime(node.modified)}${flag}`;
}

/** 会话项的展示文案。 */
export function sessionOptionLabel(info: SessionInfo, current: boolean): string {
  const mark = current ? "▶ " : "  ";
  return `${mark}${sessionLabel(info)}  ·  ${info.messageCount} 条  ·  ${relativeTime(info.modified)}`;
}

/** 生成一份可读的会话详情（用于确认弹窗 / 预览）。 */
export function sessionSummary(info: SessionInfo): string {
  return [
    `会话：${sessionLabel(info)}`,
    `目录：${info.cwd || "(未知)"}`,
    `文件：${info.path}`,
    `消息：${info.messageCount} 条`,
    `最近活动：${relativeTime(info.modified)}`,
  ].join("\n");
}
