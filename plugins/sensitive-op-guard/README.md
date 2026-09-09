# sensitive-op-guard

pi 高敏操作确认门禁扩展：在执行**读取敏感文件**或**删除/破坏性操作**前，弹出对话框要求用户明确同意，未同意则阻止。

## 拦截范围

| 操作 | 触发方式 | 默认行为 |
|---|---|---|
| 读取敏感文件 | `read` 工具的 path 命中敏感文件 | 确认后放行，否则阻止 |
| 读取敏感文件 | `bash` 里 `cat/grep/head/tail/sed/awk/...` 读取敏感文件 | 确认后放行，否则阻止 |
| 删除/破坏 | `bash` 里 `rm` / `git rm` / `find -delete` / `shred` / `rmdir` / `unlink` 等 | 确认后放行，否则阻止 |
| 写入敏感文件 | `write`/`edit` 命中敏感文件 | 默认关闭，`config.ts` 里 `GUARD_WRITE=true` 开启 |

**无交互界面（headless / CI）时默认阻止**，避免静默放行高敏操作。

## 敏感文件清单

默认命中：`.env` 及变体、`secrets*` / `credentials*` / `tokens*`、GCP service account、`id_rsa` / `id_ed25519`、`.ssh` / `.aws` / `.gnupg` 目录、`.pem` / `.p12` / `.pfx` / `.key` 等。

全部正则可编辑，见 [`config.ts`](./config.ts)。

## 安装

全局安装（推荐）：

```bash
# 克隆仓库后（假设仓库在 ~/pi-extensions）
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/sensitive-op-guard" ~/.pi/agent/extensions/sensitive-op-guard
```

或直接引用：

```bash
pi -e ~/pi-extensions/plugins/sensitive-op-guard/index.ts
```

改完配置后 `/reload`（或重启 pi）生效。

## 自定义

编辑 `config.ts`：

- `SENSITIVE_FILE_PATTERNS` —— 增删敏感文件正则
- `DELETE_COMMAND_PATTERNS` —— 增删删除命令正则
- `READ_COMMAND_PATTERNS` —— 增删"读取类"命令名
- `GUARD_WRITE` —— 是否同时拦截写入敏感文件
