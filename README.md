# pi-extensions

个人维护的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展插件集合。

每个插件是 `plugins/` 下一个独立目录，`index.ts` 为扩展入口。pi 的扩展自动发现规则是
`~/.pi/agent/extensions/*/index.ts`，因此每个插件目录可单独软链安装，互不干扰。

## 插件列表

| 插件 | 说明 | 目录 |
|---|---|---|
| [sensitive-op-guard](./plugins/sensitive-op-guard) | 读取敏感文件 / 删除操作前的确认门禁 | `plugins/sensitive-op-guard/` |
| [conventional-commit](./plugins/conventional-commit) | Conventional Commits 交互式提交 + 消息格式校验 | `plugins/conventional-commit/` |

## 安装

### 方式一：克隆 + 软链（推荐，便于跟随仓库更新）

```bash
git clone https://github.com/shuguangnet/pi-extensions.git ~/pi-extensions
mkdir -p ~/.pi/agent/extensions

# 逐个软链你想启用的插件
ln -s "$HOME/pi-extensions/plugins/sensitive-op-guard" ~/.pi/agent/extensions/sensitive-op-guard
```

改完 `/reload` 生效，或重启 pi。

### 方式二：直接引用单文件（临时测试）

```bash
pi -e ~/pi-extensions/plugins/sensitive-op-guard/index.ts
```

### 方式三：settings.json 引用（按需）

在 `~/.pi/settings.json`（或项目 `.pi/`）里通过 `extensions` 指向本地路径或 `packages` 里的 git 来源。

## 开发新插件

1. 在 `plugins/` 下新建目录，写出 `index.ts`（默认导出 `(pi: ExtensionAPI) => void`）。
2. 需要自定义配置时，新建同级 `config.ts` 并从 `index.ts` import。
3. 参考 pi 官方示例与文档：
   - 扩展文档：`@earendil-works/pi-coding-agent/docs/extensions.md`
   - 示例：`@earendil-works/pi-coding-agent/examples/extensions/`
4. 为插件写一个 README，说明拦截/功能范围与安装方式，并登记到本 README 的表格里。

## 目录结构

```
pi-extensions/
├── README.md
├── package.json            # 仅用于本地类型提示 / 开发，不参与运行时
├── tsconfig.json
└── plugins/
    └── sensitive-op-guard/
        ├── index.ts        # 扩展入口
        ├── config.ts       # 可编辑的正则/开关
        └── README.md
```
