/**
 * queue-highlight —— 让 pi 的「排队中」提示一眼可见
 *
 * pi 在输入框上方显示还没投递出去的消息，原来两行都是同一个暗灰色（theme 的 `dim`）：
 *
 *     Steering: 改一下这段逻辑        ← Enter 发送：等当前工具跑完就投递
 *     Follow-up: 顺便补个测试          ← Alt+Enter 发送：等 agent 完全停下才投递
 *
 * 这个插件把 steering 染红、follow-up 染绿（可配），并加粗，避免排队消息被淹没在暗灰里。
 *
 * 实现方式：pi 目前没有「排队区渲染」的扩展点（`updatePendingMessagesDisplay()` 里是硬编码的
 * `theme.fg("dim", \`Steering: ${msg}\`)`），所以这里 patch `Theme.prototype.fg`：
 * 只对这两行的固定前缀换色，其它任何文本原样走原逻辑，影响面被限制在最小范围。
 *
 * 命令：
 *   /qh                     查看当前状态
 *   /qh on | off            临时开关（仅当前进程）
 *   /qh bold on | off       是否加粗
 *   /qh steering <颜色名>    改 steering 颜色
 *   /qh follow <颜色名>      改 follow-up 颜色
 *
 * 安装 / 自定义见本插件 README.md 与仓库根 README.md。
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";

import {
  BOLD,
  ENABLED,
  FOLLOW_UP_COLOR,
  FOLLOW_UP_PATTERN,
  STEERING_COLOR,
  STEERING_PATTERN,
} from "./config";

const STATE_KEY = Symbol.for("pi-queue-highlight/state");
const PATCH_KEY = Symbol.for("pi-queue-highlight/patched");
const ORIGINAL_KEY = Symbol.for("pi-queue-highlight/original-fg");

interface QueueHighlightState {
  enabled: boolean;
  bold: boolean;
  steering: ThemeColor;
  followUp: ThemeColor;
  /** 命中次数，用于自检（/qh 里显示）。 */
  hits: number;
  lastHitAt?: number;
}

/**
 * 运行态放在 globalThis：`/reload` 会重建扩展模块，
 * 但 patch 挂在原型上不会重建，两边必须通过全局对象共享配置。
 */
function state(): QueueHighlightState {
  const store = globalThis as unknown as Record<symbol, QueueHighlightState | undefined>;
  let current = store[STATE_KEY];
  if (!current) {
    current = {
      enabled: ENABLED,
      bold: BOLD,
      steering: STEERING_COLOR,
      followUp: FOLLOW_UP_COLOR,
      hits: 0,
    };
    store[STATE_KEY] = current;
  } else {
    // /reload 后以 config.ts 为准刷新默认值，但保留 enabled（临时开关）
    current.steering = STEERING_COLOR;
    current.followUp = FOLLOW_UP_COLOR;
    current.bold = BOLD;
  }
  return current;
}

/** 命中排队行时返回目标颜色；不是排队行返回 undefined。 */
function targetColor(text: string): ThemeColor | undefined {
  const current = state();
  if (STEERING_PATTERN.test(text)) return current.steering;
  if (FOLLOW_UP_PATTERN.test(text)) return current.followUp;
  return undefined;
}

/**
 * 给 Theme.prototype.fg 打补丁。
 *
 * 幂等：/reload 后模块重新执行，但原型上已有补丁，直接复用；
 * 配置从 globalThis 读取，所以改了配置不需要重新打补丁。
 */
function installPatch(): void {
  const proto = Theme.prototype as unknown as Record<symbol, unknown>;
  if (proto[PATCH_KEY]) return;

  const original = Theme.prototype.fg;
  proto[ORIGINAL_KEY] = original;

  Theme.prototype.fg = function patchedFg(this: Theme, color: ThemeColor, text: string): string {
    const current = state();
    if (current.enabled && typeof text === "string") {
      const replacement = targetColor(text);
      if (replacement) {
        current.hits += 1;
        current.lastHitAt = Date.now();
        const styled = current.bold ? this.bold(text) : text;
        try {
          return original.call(this, replacement, styled);
        } catch {
          // 主题里没有这个颜色（例如自定义主题缺 key），退回原色，绝不让 TUI 崩掉
          return original.call(this, color, styled);
        }
      }
    }
    return original.call(this, color, text);
  } as typeof Theme.prototype.fg;

  proto[PATCH_KEY] = true;
}

/** 判断颜色名在当前主题里是否可用。 */
function isValidColor(theme: { fg: (color: ThemeColor, text: string) => string }, value: string): boolean {
  try {
    theme.fg(value as ThemeColor, "x");
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  installPatch();

  pi.registerCommand("qh", {
    description: "排队提示高亮：steering 红 / follow-up 绿（/qh on|off|bold|steering <色>|follow <色>|test）",
    handler: async (args, ctx) => {
      const current = state();
      const [action, value] = args.trim().split(/\s+/, 2);
      const verb = (action ?? "").toLowerCase();
      const theme = ctx.ui.theme;

      if (!verb) {
        ctx.ui.notify(
          [
            `排队高亮：${current.enabled ? "开启" : "关闭"}｜加粗：${current.bold ? "开" : "关"}`,
            `steering → ${current.steering}｜follow-up → ${current.followUp}`,
            `已命中 ${current.hits} 行${current.lastHitAt ? `，最近 ${new Date(current.lastHitAt).toLocaleTimeString()}` : ""}`,
            "可用颜色：accent / success / error / warning / muted / dim / text / mdLink …",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (verb === "on") {
        current.enabled = true;
        ctx.ui.notify("排队高亮已开启", "info");
        return;
      }
      if (verb === "off") {
        current.enabled = false;
        ctx.ui.notify("排队高亮已关闭（当前进程内生效）", "info");
        return;
      }
      if (verb === "bold") {
        const next = (value ?? "").toLowerCase();
        if (next !== "on" && next !== "off") {
          ctx.ui.notify("用法：/qh bold on|off", "warning");
          return;
        }
        current.bold = next === "on";
        ctx.ui.notify(`排队高亮加粗已${current.bold ? "开启" : "关闭"}`, "info");
        return;
      }
      if (verb === "test") {
        // 自检：patch 生效时，dim 着色的 Steering 行会等于目标色着色的同一文本
        const probe = "Steering: probe";
        const followProbe = "Follow-up: probe";
        const patched = theme.fg("dim", probe) === theme.fg(current.steering, probe);
        const patchedFollow = theme.fg("dim", followProbe) === theme.fg(current.followUp, followProbe);
        const normal = theme.fg("dim", "normal probe") !== theme.fg(current.steering, "normal probe");
        ctx.ui.notify(
          [
            `steering 命中：${patched ? "✅" : "❌"}（应被染成 ${current.steering}）`,
            `follow-up 命中：${patchedFollow ? "✅" : "❌"}（应被染成 ${current.followUp}）`,
            `普通文本未被误伤：${normal ? "✅" : "❌"}`,
            `开关：${current.enabled ? "开" : "关"}｜加粗：${current.bold ? "开" : "关"}｜累计命中 ${current.hits} 行`,
          ].join("\n"),
          patched && patchedFollow ? "info" : "error",
        );
        return;
      }

      if (verb === "steering" || verb === "follow") {
        const color = value ?? "";
        if (!color || !isValidColor(theme, color)) {
          ctx.ui.notify(`颜色不可用：${color || "(空)"}。换一个主题里存在的颜色名。`, "warning");
          return;
        }
        if (verb === "steering") current.steering = color as ThemeColor;
        else current.followUp = color as ThemeColor;
        ctx.ui.notify(`${verb === "steering" ? "steering" : "follow-up"} 颜色已改为 ${color}`, "info");
        return;
      }

      ctx.ui.notify("用法：/qh [on|off|bold on|bold off|steering <颜色>|follow <颜色>]", "warning");
    },
  });

  // 关闭时在状态栏留个提醒（开启时不占用状态栏）
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("qh", state().enabled ? undefined : "qh:off");
  });
}
