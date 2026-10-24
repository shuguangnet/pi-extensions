---
name: cloudssh-ssh-config
description: 把 cloudssh 面板的主机列表批量导入本地 ~/.ssh/config，统一私钥、幂等维护，并实测连通性。当用户说"拉取 cloudssh 主机列表加到 ssh config""给这些机器配 ssh 别名""统一用某一把私钥连所有机器""ssh 别名连不上 / 私钥 invalid format / Permission denied"时使用。
metadata:
  short-description: cloudssh 主机 → 本地 ssh 别名，一把私钥管全部
---

# cloudssh → ssh config

把 cloudssh 面板里的 15 台机器变成 `ssh bero` 这种短命令，全部走同一把私钥，并验证每一台真的连得上。

## 铁律

1. **绝不把私钥内容打进对话、命令历史或 commit。** 私钥只落地到 `~/.ssh/<name>`，权限 600。要"粘贴"就给用户 `nano` 或编辑器，不要 `echo '<私钥>' >>`。
2. **先校验私钥结构，再测连通。** `Permission denied (publickey)` 有两类完全不同的原因：key 没装到服务器，或本地 key 文件本身坏。不先排除后者就会白折腾远端 `authorized_keys`。
3. **批量测试必须带 `-o BatchMode=yes -o ConnectTimeout=8`。** 否则一旦机器需要密码或不通，整个循环会卡在交互提示上。并行跑，别串行。
4. **区分 `Permission denied` 和 `Connection timed out`。** 前者是 key 没部署到那台机器；后者是机器/防火墙/sshd 问题，跟私钥无关，去改 `authorized_keys` 是徒劳。
5. **托管块要有 BEGIN/END 标记。** `~/.ssh/config` 里可能有 OrbStack 的 `Include`、`codex-vps` 之类手工 Host，脚本只能替换自己那一块，其余一个字不动。

## 全流程

### 1. 拿 cloudssh token

面板地址形如 `https://ssh.933999.xyz`，token 前缀 `cssh_`。三个来源按优先级：`--token` 参数 → `CLOUDSSH_TOKEN` 环境变量 → `~/.pi/agent/mcp.json` 里 `mcpServers.cloudssh.headers.Authorization`。

token 是否还活着，一条命令验证（比读 MCP 报错准得多）：

```bash
curl -s -X POST https://ssh.933999.xyz/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $CLOUDSSH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

- 回 `{"error":"Invalid, expired, revoked or disabled access token"}` → token 废了，去面板重新生成。
- 列出工具名 → token 有效，进入下一步。

> **工具名陷阱**：这个面板的工具名**不带服务器前缀**，是 `list_servers` / `execute_command`，不是 `cloudssh_list_servers`。pi 的 MCP 缓存可能还留着带前缀的旧名字，直接调会报 `Tool ... not found`；用 `tools/list` 看真名，或用本 skill 的脚本（脚本直连 HTTP，绕过缓存）。

### 2. 拉主机列表

```bash
python3 scripts/cloudssh-sync.py --dry-run          # 先看生成的 config
python3 scripts/cloudssh-sync.py                    # 真正写入 ~/.ssh/config
```

脚本做的事：

- 调 `list_servers`，把每台机器写成 `Host <alias>` + `HostName` / `User` / `Port` + 统一 `IdentityFile` + `IdentitiesOnly yes`
- 用 `# >>> cloudssh managed block >>>` … `# <<< cloudssh managed block <<<` 包裹，**幂等**：重复运行只替换中间那段
- 别名映射持久化到 `~/.ssh/cloudssh-aliases.json`，下次沿用，不会因为主机改名而漂移
- 自动别名是兜底（如 `crunchbits-2269-3c5g120g`、`srv-9929`），**跑完编辑这个 JSON 改成你喜欢的短名，再跑一次**即可

| 参数 | 说明 |
|---|---|
| `--dry-run` | 只打印，不写文件 |
| `--key` | 换私钥路径（默认 `~/.ssh/ssh_control`） |
| `--config` | 写别的文件，用于演练 |
| `--aliases` | 换别名映射路径 |
| `--token` | 显式传 token |

### 3. 私钥落地

**先建文件再让用户粘，否则编辑器会把权限建成 644。**

```bash
: > ~/.ssh/ssh_control && chmod 600 ~/.ssh/ssh_control
nano ~/.ssh/ssh_control        # Cmd+V 粘贴 → Ctrl+O 回车保存 → Ctrl+X
```

编辑器选择：`nano` 最稳。**绝对不要用 macOS「文本编辑」**——Smart Dashes 会把 `-----BEGIN` 里的 `--` 换成 em dash `—`，私钥当场报废。

想先确认剪贴板里是不是私钥（只判断不回显内容）：

```bash
pbpaste | grep -qE -- '-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----' && echo 剪贴板是私钥 || echo 不是
```

### 4. 校验私钥（关键一步，能省掉大量乱试）

```bash
python3 scripts/inspect-private-key.py ~/.ssh/ssh_control
```

它逐字节检查并把 `invalid format` 定位到具体原因：末尾是否缺 `\n`、CRLF、base64 非法字符、PEM 标签匹配、`openssh-key-v1` magic、checkint、padding、comment，最后再用 `ssh-keygen -y` 交叉验证。可自动修：

```bash
python3 scripts/inspect-private-key.py ~/.ssh/ssh_control --fix
```

`--fix` 处理：补末尾换行、CRLF→LF、`chmod 600`。

### 5. 并行测连通

```bash
ALIASES="bero minibox aliyun-bj vps"   # 换成你的别名
for a in $ALIASES; do
  ( out=$(ssh -o BatchMode=yes -o ConnectTimeout=8 \
            -o StrictHostKeyChecking=accept-new \
            -o NumberOfPasswordPrompts=0 "$a" \
            'echo "OK|$(hostname)|$(uname -sr)"' 2>&1)
    echo "$a|$?|$(echo "$out" | tr '\n' ' ' | cut -c1-100)" ) &
done
wait
```

`StrictHostKeyChecking=accept-new` 只自动接受首次指纹，之后仍会拦篡改，比 `no` 安全。

### 6. 补公钥（只针对 `Permission denied` 的那几台）

本质是把 `ssh_control` 的公钥追加进远端 `authorized_keys`：

```bash
PUB=$(ssh-keygen -y -f ~/.ssh/ssh_control)   # 有 passphrase 会提示一次
ssh -i ~/.ssh/ssh_control <user>@<host> \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
   grep -qF '$PUB' ~/.ssh/authorized_keys 2>/dev/null || echo '$PUB' >> ~/.ssh/authorized_keys; \
   chmod 600 ~/.ssh/authorized_keys"
```

但这台机器本来就 `Permission denied`，所以要用**另一条可用通道**执行：cloudssh 面板的 Web 终端，或它的 `execute_command`（面板自有凭据）。

### 7. 日常维护

主机增减、换私钥、token 轮换，重跑一次脚本即可，手工 Host 不受影响：

```bash
python3 scripts/cloudssh-sync.py
```

`scp` / `rsync` / `git` 自动复用别名：

```bash
scp app.tar.gz bero:/opt/
rsync -avz ./dist/ aliyun-bj:/www/site/
```

## 排错表

| 现象 | 真因 | 处理 |
|---|---|---|
| `ssh-keygen`: `invalid format`，但 base64 看着完好 | **文件末尾缺换行**，OpenSSH 按行解析 PEM，最后一行无 `\n` 被丢弃 → 找不到 END | `printf '\n' >> key`，或 `--fix` |
| `Load key: invalid format` + 有 `—` 字符 | 文本编辑器 Smart Dashes 把 `--` 改成了 `—` | 用 nano / VSCode 重粘 |
| `Permissions 0644 for 'key' are too open` | 权限过宽 | `chmod 600 key`；目录 `chmod 700 ~/.ssh` |
| 所有机器同时 `Permission denied` | 私钥文件本身坏（先跑第 4 步），或公钥根本没装 | 先 `inspect-private-key.py`，再逐台补公钥 |
| 个别机器 `Permission denied`，其余正常 | 那几台 `authorized_keys` 里没有这把公钥 | 第 6 步 |
| `Connection timed out during banner exchange` | 端口通、sshd 没正常应答：机器宕 / 防火墙 / sshd 挂 | 与 key 无关，去面板看机器状态 |
| `Connection refused` | 22 端口没开或被挡 | 查面板端口 / 云防火墙 |
| `Tool cloudssh_list_servers not found` | MCP 缓存了带前缀的旧工具名 | 用 `list_servers`，或改用本 skill 脚本 |
| `Invalid, expired, revoked or disabled access token` | token 过期 | 面板重新生成，更新 `mcp.json` 或 `--token` |
| 连上了但不是预期机器 | 别名撞车 / 手工 Host 覆盖 | `ssh -G <alias>` 看最终生效的 hostname |

一条命令确认某个别名最终解析成什么：

```bash
ssh -G bero | grep -E '^(hostname|user|port|identityfile) '
```

## 已知边界：为什么不能"完全不用私钥"

cloudssh 的面板确实自带一条 `wss://<host>/api/ssh` 的 SSH-over-WebSocket 代理（前端 xterm 用它），理论上接上它就能做真正的 `ProxyCommand`，本地零私钥、且 `scp` / `rsync` / `git` 全部可用。但那需要逆向它的握手协议和会话鉴权（前端走 cookie + 设备签名），不属于本 skill 的范围。

**不要**试图用 MCP 的 `execute_command` 去凑一个 `ssh`：它是「一条命令 → 一段文本输出」的一次性 RPC（上限 180s，无 stdin 流、无 PTY、无 window resize），而 OpenSSH 需要全双工字节流。硬接的结果是没有交互式 shell、不能 scp/sftp、长任务被超时砍断，比配好私钥差得多。

所以本 skill 的立场是：**把私钥配好一次，之后长期省事**，而不是绕开私钥。真要做到"本地不落盘"，正确方向是用 ssh-agent 转发 / 硬件 token（私钥留在 agent 进程内），不是把连接托管给面板。

## 安装本 skill

```bash
git clone https://github.com/shuguangnet/pi-extensions.git ~/pi-extensions
ln -sfn "$HOME/pi-extensions/skills/cloudssh-ssh-config" ~/.pi/agent/skills/cloudssh-ssh-config
# 其他 agent：ln -sfn ... ~/.agents/skills/cloudssh-ssh-config
```

## 真实案例（本 skill 的由来）

一次全流程实测，11/15 台一次连通，4 台失败，其中 3 台是没装公钥、1 台是机器侧超时。**开头所有机器全都 `Permission denied`**，一度怀疑是面板凭据或 config 写错，实际是粘贴私钥时末尾少了一个 `\n`：base64 合法、magic 正确、checkint 一致、padding 正确、comment 正常，只有末尾没有换行。肉眼看不出、`ssh-keygen` 只回一句 `invalid format`。补一个字节，全部恢复。

这就是 `scripts/inspect-private-key.py` 存在的原因——把这种"看起来对但就是不工作"的问题变成一次运行的结果。
