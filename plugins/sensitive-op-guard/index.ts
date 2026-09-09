/**
 * sensitive-op-guard —— pi 高敏操作确认门禁
 *
 * 拦截两类操作并在执行前强制用户确认：
 *   1. 读取敏感文件（.env、secrets、credentials、私钥、.ssh/.aws/.gnupg 等）
 *   2. 删除/破坏性操作（rm、git rm、find -delete、shred ...）
 *
 * 实现方式：监听 `tool_call` 事件（在工具真正执行前触发，可 block）——
 *   - `read` 工具的 path 命中敏感文件 → 确认
 *   - `bash` 命令匹配删除模式 → 确认
 *   - `bash` 命令用 cat/grep 等读取敏感文件 → 确认
 *   - 无交互界面（!ctx.hasUI）时默认阻止，避免静默放行高敏操作
 *
 * 安装 / 使用见本插件 README.md 与仓库根 README.md。
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import {
  SENSITIVE_FILE_PATTERNS,
  DELETE_COMMAND_PATTERNS,
  READ_COMMAND_PATTERNS,
  GUARD_WRITE,
} from "./config";

/** 判断一个文件路径是否命中敏感文件模式。 */
function isSensitivePath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(p));
}

/** 判断一条 bash 命令是否属于"删除/破坏性"操作。 */
function isDeleteCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  return DELETE_COMMAND_PATTERNS.some((re) => re.test(cmd));
}

/**
 * 判断一条 bash 命令是否在"读取敏感文件"：
 *   1) 命令里出现了读文件类的命令名（cat/grep/head/tail/...）
 *   2) 且命令文本里出现了敏感文件路径 token
 * 返回命中的敏感路径 token（用于展示给用户），未命中返回 null。
 */
function detectSensitiveBashRead(command: string): string | null {
  if (!READ_COMMAND_PATTERNS.some((re) => re.test(command))) return null;

  // 宽松地扫描命令里的每个空白分隔 token，找像路径且命中的敏感文件。
  const tokens = command.split(/[\s;|&<>]+/).filter(Boolean);
  for (const token of tokens) {
    // 去掉常见的引号包裹
    const cleaned = token.replace(/^['"]|['"]$/g, "");
    if (cleaned.includes("/") || /\.env|secret|credential|id_rsa|id_ed25519|\.pem|\.key/iu.test(cleaned)) {
      if (isSensitivePath(cleaned)) return cleaned;
    }
  }

  // 兜底：整条命令文本直接匹配（处理 cat ".env" 这种带引号写法）
  const m = command.match(
    /(?:\.env[\w.-]*|\S*(?:secret|credential|id_rsa|id_ed25519|id_dsa|\.pem|\.key|\.p12|\.pfx)\S*)/iu,
  );
  if (m && isSensitivePath(m[0])) return m[0];

  return null;
}

/** 统一封装确认 + 阻止逻辑。 */
async function confirmOrBlock(
  ctx: { hasUI: boolean; ui: { confirm: (t: string, b: string) => Promise<boolean> } },
  title: string,
  body: string,
  blockReason: string,
): Promise<{ block: true; reason: string } | undefined> {
  // 非交互模式（CI / headless）无法询问用户，出于安全默认阻止。
  if (!ctx.hasUI) {
    return { block: true, reason: `${title}（无交互界面，默认阻止）: ${blockReason}` };
  }

  const ok = await ctx.ui.confirm(`⚠️ ${title}`, body);
  if (!ok) {
    return { block: true, reason: `${title} 已被用户阻止: ${blockReason}` };
  }
  return undefined; // 放行
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    // ---- 1. 读取敏感文件：read 工具 ----
    if (isToolCallEventType("read", event)) {
      const path = String(event.input.path ?? "");
      if (isSensitivePath(path)) {
        return confirmOrBlock(
          ctx,
          "需要确认：读取敏感文件",
          `检测到即将读取敏感文件，可能包含密钥/凭据等机密信息：\n\n  ${path}\n\n是否允许本次读取？`,
          path,
        );
      }
      return undefined;
    }

    // ---- 2. （可选）写入/编辑敏感文件 ----
    if (GUARD_WRITE) {
      if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
        const path = String(event.input.path ?? "");
        if (isSensitivePath(path)) {
          return confirmOrBlock(
            ctx,
            "需要确认：写入敏感文件",
            `检测到即将修改敏感文件：\n\n  ${path}\n\n是否允许本次写入？`,
            path,
          );
        }
      }
    }

    // ---- 3. bash：删除/破坏性命令 ----
    if (isToolCallEventType("bash", event)) {
      const command = String(event.input.command ?? "");

      if (isDeleteCommand(command)) {
        return confirmOrBlock(
          ctx,
          "需要确认：删除操作",
          `检测到删除/破坏性命令：\n\n  ${command}\n\n此操作可能不可恢复，是否允许执行？`,
          command,
        );
      }

      // ---- 4. bash：读取敏感文件 ----
      const sensitive = detectSensitiveBashRead(command);
      if (sensitive) {
        return confirmOrBlock(
          ctx,
          "需要确认：读取敏感文件",
          `检测到命令尝试读取敏感文件：\n\n  ${sensitive}\n\n命令：${command}\n\n是否允许？`,
          sensitive,
        );
      }

      return undefined;
    }

    return undefined;
  });
}
