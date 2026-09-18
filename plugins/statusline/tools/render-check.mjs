/**
 * statusline 渲染自检（脱离 TUI）
 *
 *   node plugins/statusline/tools/render-check.mjs
 *
 * 用真实的 pi 主题 + 一组模拟数据，检查不同终端宽度下的排版、降级与着色。
 */

import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti("/Users/liushuguang/pi-extensions/index.mjs");
const piPkg = await jiti.import("@earendil-works/pi-coding-agent");
piPkg.initTheme("dark");
const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];

const { renderStatusline, formatTokens, shortenCwd } = await jiti.import(
  "/Users/liushuguang/pi-extensions/plugins/statusline/render.ts",
);
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (text) => text.replace(ANSI, "");
const width = (text) => visibleWidth(text);

const data = {
  cwd: "/Users/liushuguang/gym-iam-runtime",
  home: "/Users/liushuguang",
  branch: "feature/develop",
  sessionName: "参考其他权限，为组装单 组装方案 成本调整单等增加对应权限，同时在saas-ui埋点",
  modelId: "deepseek-v4.1-flash",
  provider: "openai",
  providerCount: 1,
  thinkingLevel: "high",
  reasoning: true,
  usage: {
    input: 390_000,
    output: 144_000,
    cacheRead: 28_000_000,
    cacheWrite: 1_200_000,
    cost: 0.4231,
    cacheHitRate: 94.2,
  },
  context: { percent: 28.4, contextWindow: 1_000_000 },
  autoCompact: true,
  statuses: ["🛰 1 跑中"],
};

console.log("formatTokens:", [999, 1000, 390_000, 1_000_000, 1_500_000].map(formatTokens).join(" "));
console.log("shortenCwd  :", shortenCwd("/Users/liushuguang/a/b/c/d/e/f", "/Users/liushuguang"));
console.log();

for (const columns of [200, 120, 100, 80, 64, 44]) {
  console.log(`── width ${columns} ${"─".repeat(40)}`);
  const lines = renderStatusline(data, theme, columns);
  for (const [index, line] of lines.entries()) {
    const w = width(line);
    const overflow = w > columns ? `  ⚠️ OVERFLOW(+${w - columns})` : "";
    console.log(`${index + 1}) [${String(w).padStart(3)}] ${strip(line)}${overflow}`);
  }
  console.log();
}

console.log("── 颜色检查（原始转义） ──────────────────");
const colored = renderStatusline(data, theme, 200);
console.log("header:", JSON.stringify(colored[0].slice(0, 90)));
console.log("stats :", JSON.stringify(colored[1].slice(0, 160)));

console.log();
console.log("── 阈值变色（70% 黄 / 90% 红） ──────────────");
for (const percent of [12.5, 71.2, 95.8, null]) {
  const sample = { ...data, context: { percent, contextWindow: 1_000_000 } };
  const line = renderStatusline(sample, theme, 200)[1];
  const color = line.match(/\u001b\[(38;2;[0-9;]+)m/)?.[1] ?? "none";
  console.log(`percent=${String(percent).padStart(5)} → 首个色码 ${color.padEnd(16)} ${strip(line).slice(0, 46)}`);
}

console.log();
console.log("── 边界数据（新会话 / 无 git / 无 context） ──");
const fresh = {
  cwd: "/tmp",
  home: "/Users/liushuguang",
  branch: null,
  sessionName: undefined,
  modelId: undefined,
  providerCount: 0,
  reasoning: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  context: { percent: null, contextWindow: 200_000 },
  autoCompact: true,
  statuses: [],
};
for (const line of renderStatusline(fresh, theme, 90)) console.log("[", width(line), "]", strip(line));
