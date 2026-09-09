# conventional-commit

pi Conventional Commits 助手：交互式生成符合规范的提交，并校验 `git commit` 消息格式。

## 能力

### 1. `/commit` 命令（交互式提交）

在 git 仓库里输入 `/commit`：

1. 显示已暂存(staged)改动摘要
2. 选择提交类型：`feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert`
3. 输入可选作用域（如 `api`、`order`）
4. 输入中文描述
5. 确认后执行 `git commit -m "type(scope): 描述"`

> 需要先 `git add` 暂存改动；无暂存改动会提示。

### 2. 提交消息格式校验

拦截 `bash` 里的 `git commit -m "..."`，若消息不符合
`type(scope): 描述` 格式，弹窗让用户确认是否仍要提交（默认阻止）。
无交互界面（headless/CI）时直接阻止。

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/conventional-commit" ~/.pi/agent/extensions/conventional-commit
```

改完 `/reload` 或重启 pi 生效。

## 自定义

- 提交类型列表：编辑 `index.ts` 里的 `COMMIT_TYPES`
- 校验正则：编辑 `CONVENTIONAL_RE`
