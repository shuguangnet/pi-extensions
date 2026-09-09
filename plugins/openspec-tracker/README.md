# openspec-tracker

pi OpenSpec 变更状态提醒：会话启动时检查当前项目 `openspec/changes/` 下有没有"已实现但未归档"的变更，提醒运行 `/opsx-archive` 收尾，避免变更堆积。

## 能力

### 1. 会话启动自动提醒

在 `session_start`（默认 `startup` / `new` 场景）时：

1. 从当前目录向上查找 `openspec/` 根
2. 列出 `openspec/changes/` 下所有变更
3. 检查每个变更的 `tasks.md`：**全部勾选（无 `- [ ]`）= 已实现**
4. 有已实现但未归档的变更 → 弹窗提醒，列出变更名并提示 `/opsx-archive`

### 2. `/opsx-status` 命令

手动查看当前项目已实现但未归档的变更。

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/openspec-tracker" ~/.pi/agent/extensions/openspec-tracker
```

改完 `/reload` 或重启 pi 生效。

## 自定义

编辑 `config.ts`：

- `OPENSPEC_DIR` / `CHANGES_DIR` / `TASKS_FILE` —— 目录与文件名
- `REMIND_ON` —— 在哪些 `session_start` 场景提醒（`startup`/`new`/`resume`/`fork`/`reload`）
