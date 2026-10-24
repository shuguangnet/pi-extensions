#!/usr/bin/env python3
"""
从 cloudssh 面板（默认 https://ssh.933999.xyz）拉取主机列表，幂等同步进 ~/.ssh/config。

特点
  * 幂等：块内容由 BEGIN/END 标记包裹，重复运行只替换中间部分，不碰你手工写的 Host
  * 别名稳定：别名映射持久化在 --aliases 指定的 JSON 里，下次运行沿用，不会因为主机改名而漂移
  * 只依赖标准库，Python 3.9+ 即可，macOS / Linux 通用
  * --dry-run 先看结果，--config 可指向临时文件做演练

用法
  python3 cloudssh-sync.py                       # 同步
  python3 cloudssh-sync.py --dry-run             # 只打印
  python3 cloudssh-sync.py --key ~/.ssh/other    # 换私钥
  python3 cloudssh-sync.py --config /tmp/x       # 写到别处（演练）

Token 来源（按优先级）
  1. --token 参数
  2. 环境变量 CLOUDSSH_TOKEN
  3. MCP 配置文件里 mcpServers.cloudssh.headers.Authorization

退出码
  0 成功 / 1 token 或网络失败 / 2 无主机
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_MCP_URL = "https://ssh.933999.xyz/mcp"
DEFAULT_MCP_JSON = Path.home() / ".pi" / "agent" / "mcp.json"
DEFAULT_CONFIG = Path.home() / ".ssh" / "config"
DEFAULT_ALIASES = Path.home() / ".ssh" / "cloudssh-aliases.json"

BEGIN = "# >>> cloudssh managed block (auto-generated, do not edit) >>>"
END = "# <<< cloudssh managed block <<<"


# --------------------------------------------------------------------------- token
def resolve_token(cli_token, mcp_json):
    if cli_token:
        return cli_token.strip()
    env = os.environ.get("CLOUDSSH_TOKEN", "").strip()
    if env:
        return env
    if mcp_json.exists():
        try:
            data = json.loads(mcp_json.read_text())
            auth = (
                data.get("mcpServers", {})
                .get("cloudssh", {})
                .get("headers", {})
                .get("Authorization", "")
            )
            if auth.lower().startswith("bearer "):
                return auth[7:].strip()
        except (json.JSONDecodeError, OSError):
            pass
    return ""


# ---------------------------------------------------------------------------- rpc
def rpc(url, token, method, params, timeout=30):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer " + token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        sys.exit(
            "HTTP %s 拉取失败：%s\n"
            "→ 多半是 token 失效。去面板重新生成 access token，"
            "再用 --token 传入或更新 mcp.json。" % (exc.code, detail)
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        sys.exit("网络错误：%s" % exc)

    # 部分服务端用 SSE 帧返回： "event: message\\ndata: {...}"
    if raw.lstrip().startswith(("event:", "data:")):
        raw = "\n".join(
            line[5:].strip() for line in raw.splitlines() if line.startswith("data:")
        )

    payload = json.loads(raw)

    # 顶层 error 是鉴权/协议错误；result 里的 isError 是工具级错误
    if "error" in payload:
        err = payload["error"]
        sys.exit("cloudssh 协议错误：%s" % (err.get("message") or err))
    result = payload.get("result", {})
    if result.get("isError"):
        msg = ""
        for item in result.get("content", []):
            if item.get("type") == "text":
                msg += item.get("text", "")
        sys.exit(
            "cloudssh 工具错误：%s\n"
            "→ 若提示 tool not found，检查工具名。本面板的工具名不带服务器前缀，"
            "是 list_servers 而不是 cloudssh_list_servers。" % msg.strip()
        )
    return result


def fetch_servers(url, token):
    result = rpc(url, token, "tools/call", {"name": "list_servers", "arguments": {}})
    for item in result.get("content", []):
        if item.get("type") == "text":
            data = json.loads(item["text"])
            return data.get("servers", data if isinstance(data, list) else [])
    sys.exit("list_servers 返回里没有文本内容，结构变了？")


# --------------------------------------------------------------------------- alias
def slugify(name, sid):
    s = name.lower()
    s = re.sub(r"[\s$]+", "-", s)
    s = re.sub(r"[^a-z0-9_-]", "", s)   # 点也不留：Host 别名干净点更好读
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if not s or re.match(r"^\d", s):      # 纯数字/数字开头不好看，加 srv- 前缀
        s = ("srv-" + s).strip("-")
    return s or "srv-%s" % sid


def load_aliases(path):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            print("警告：%s 不是合法 JSON，忽略" % path, file=sys.stderr)
    return {}


def save_aliases(path, aliases):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(aliases, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
    os.chmod(path, 0o600)


# -------------------------------------------------------------------------- render
def render_block(servers, key, url, aliases, assigned):
    """assigned: {alias: sid}，由本函数填充，用于检测同名主机。"""
    lines = [
        BEGIN,
        "# 来源: %s" % url,
        "# 统一私钥: %s" % key,
        "# 别名映射: 见 --aliases 指定的 JSON；重新生成: cloudssh-sync.py",
        "",
    ]
    for srv in sorted(servers, key=lambda x: x.get("id", 0)):
        sid = str(srv.get("id"))
        name = srv.get("name") or "server-%s" % sid

        entry = aliases.get(sid)
        alias = entry.get("alias") if isinstance(entry, dict) else entry
        alias = alias or slugify(name, sid)

        # 同名冲突只可能来自两台不同主机 slug 撞车；加 -1/-2 而不是 -<id>
        base, n = alias, 1
        while assigned.get(alias, sid) != sid:
            alias = "%s-%d" % (base, n)
            n += 1
        assigned[alias] = sid

        lines += [
            "# [id:%s] %s" % (sid, name),
            "Host %s" % alias,
            "    HostName %s" % srv.get("host"),
            "    User %s" % (srv.get("username") or "root"),
            "    Port %s" % (srv.get("port") or 22),
            "    IdentityFile %s" % key,
            "    IdentitiesOnly yes",
            "",
        ]
    lines += ["", END]
    return "\n".join(lines)


def apply_block(text, block):
    pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.DOTALL)
    if pattern.search(text):
        return pattern.sub(lambda _: block, text), False
    trailer = "" if text.endswith("\n") or not text else "\n"
    return text + trailer + ("\n" if text else "") + block + "\n", True


# ---------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="同步 cloudssh 主机列表到 ~/.ssh/config")
    ap.add_argument("--url", default=DEFAULT_MCP_URL, help="cloudssh MCP 端点")
    ap.add_argument("--token", help="access token（默认读 env / mcp.json）")
    ap.add_argument("--mcp-json", default=str(DEFAULT_MCP_JSON), help="mcp.json 路径")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG), help="ssh config 路径")
    ap.add_argument("--aliases", default=str(DEFAULT_ALIASES), help="别名映射 JSON 路径")
    ap.add_argument("--key", default="~/.ssh/ssh_control", help="统一使用的私钥路径")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    ap.add_argument("--no-save-aliases", action="store_true", help="不回写别名映射")
    args = ap.parse_args()

    config = Path(args.config).expanduser()
    aliases_path = Path(args.aliases).expanduser()

    token = resolve_token(args.token, Path(args.mcp_json).expanduser())
    if not token:
        sys.exit(
            "没有可用的 cloudssh token。\n"
            "→ 用 --token 传入、设置 CLOUDSSH_TOKEN，"
            "或在 mcp.json 的 mcpServers.cloudssh.headers.Authorization 里配置。"
        )

    servers = fetch_servers(args.url, token)
    if not servers:
        sys.exit(2)

    aliases = load_aliases(aliases_path)
    assigned = {}
    block = render_block(servers, args.key, args.url, aliases, assigned)

    old = config.read_text() if config.exists() else ""
    new, created = apply_block(old, block)

    # 回写新主机/别名，保持下次稳定
    new_aliases = dict(aliases)
    for srv in servers:
        sid = str(srv.get("id"))
        if sid in new_aliases:
            continue
        m = re.search(
            r"# \[id:%s\][^\n]*\nHost (\S+)" % re.escape(sid), block
        )
        new_aliases[sid] = {"alias": m.group(1) if m else slugify(srv.get("name", ""), sid),
                            "name": srv.get("name"), "host": srv.get("host")}

    if args.dry_run:
        print(new)
        print("\n# ---- 别名映射（将写入 %s）----" % aliases_path, file=sys.stderr)
        print(json.dumps(new_aliases, indent=2, ensure_ascii=False, sort_keys=True),
              file=sys.stderr)
        return

    config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if created and not config.exists():
        config.touch(mode=0o600)
    if new != old:
        config.write_text(new)
    os.chmod(config, 0o600)

    if not args.no_save_aliases and new_aliases != aliases:
        save_aliases(aliases_path, new_aliases)

    print("已同步 %d 台主机 → %s（%s）" % (
        len(servers), config, "新建托管块" if created else "替换托管块"))
    if created:
        pass


if __name__ == "__main__":
    main()
