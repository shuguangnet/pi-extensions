# dirty-repo-guard

pi 脏仓库守卫：在切换 / 新建 / fork / 压缩会话前，检测当前 git 仓库是否有未提交改动，有则弹窗提醒，防止误清空 / 切换丢失未提交的工作。

## 拦截范围

| 事件 | 默认 | 说明 |
|---|---|---|
| 切换 / 新建会话 | 开 | 防止误清空丢工作 |
| fork 会话 | 开 | 防止 fork 时丢失改动 |
| 压缩会话 | 关 | 压缩只是摘要，不丢工作，按需开启 |

**无交互界面（headless / CI）时默认阻止**（`BLOCK_HEADLESS=true`）。

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/dirty-repo-guard" ~/.pi/agent/extensions/dirty-repo-guard
```

改完 `/reload` 或重启 pi 生效。

## 自定义

编辑 `config.ts`：

- `GUARD_SWITCH` / `GUARD_FORK` / `GUARD_COMPACT` —— 开关各事件
- `BLOCK_HEADLESS` —— 无交互界面时是否默认阻止
