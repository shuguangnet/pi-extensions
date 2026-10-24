#!/usr/bin/env python3
"""
诊断 SSH 私钥文件，把 "invalid format" 这类玄学错误定位到具体字节。

为什么需要它：`ssh-keygen -y -f key` 只说一句 "invalid format"，不告诉你哪里坏了。
最常见的真凶是**文件末尾缺换行**——OpenSSH 的 PEM 解析器按行读、要求每行以 \\n 结尾，
最后一行没有换行就会被整行丢弃，于是找不到 END 标记，报 invalid format。
这种情况下 base64 是完好的、结构也是完好的，肉眼完全看不出来。

用法
  python3 inspect-private-key.py ~/.ssh/ssh_control
  python3 inspect-private-key.py ~/.ssh/ssh_control --fix     # 自动修可修的（尾换行 / CRLF / 权限）
  python3 inspect-private-key.py ~/.ssh/ssh_control --json    # 机器可读输出

退出码
  0 结构有效 / 1 有问题 / 2 不是可识别的私钥
"""

import argparse
import base64
import json
import os
import re
import sys

PEM_TYPES = {
    "OPENSSH PRIVATE KEY": "openssh",
    "RSA PRIVATE KEY": "pem-rsa",
    "EC PRIVATE KEY": "pem-ec",
    "DSA PRIVATE KEY": "pem-dsa",
    "PRIVATE KEY": "pkcs8",
    "ENCRYPTED PRIVATE KEY": "pkcs8-enc",
}


def read_u32(buf, off):
    if off + 4 > len(buf):
        raise ValueError("越界读 uint32 @%d（总长 %d）" % (off, len(buf)))
    return int.from_bytes(buf[off:off + 4], "big"), off + 4


def read_str(buf, off):
    n, off = read_u32(buf, off)
    if off + n > len(buf):
        raise ValueError("越界读 string(len=%d) @%d（总长 %d）" % (n, off, len(buf)))
    return buf[off:off + n], off + n


def analyze_openssh_payload(blob):
    """解析 openssh-key-v1 容器。返回 (info dict, problems list)。"""
    info, problems = {}, []
    off = 15
    cipher, off = read_str(blob, off)
    kdf, off = read_str(blob, off)
    kdfopts, off = read_str(blob, off)
    nkeys, off = read_u32(blob, off)
    info["ciphername"] = cipher.decode(errors="replace")
    info["kdfname"] = kdf.decode(errors="replace")
    info["kdfoptions_len"] = len(kdfopts)
    info["nkeys"] = nkeys

    if nkeys != 1:
        problems.append("nkeys=%d，多密钥容器较少见" % nkeys)

    pub, off = read_str(blob, off)
    try:
        kt, p = read_str(pub, 0)
        klen, _ = read_u32(pub, p)
        info["public_key_type"] = kt.decode(errors="replace")
        info["public_key_bits"] = klen * 8 if kt != b"ssh-ed25519" else 256
    except ValueError:
        info["public_key_type"] = "<解析失败>"

    sec, off = read_str(blob, off)
    info["private_section_len"] = len(sec)
    info["trailing_bytes"] = len(blob) - off

    if cipher != b"none":
        info["encrypted"] = True
        info["note"] = "私钥有 passphrase（cipher=%s），内部字段无法离线校验" % cipher.decode()
        return info, problems

    info["encrypted"] = False
    try:
        p = 0
        c1, p = read_u32(sec, p)
        c2, p = read_u32(sec, p)
        info["checkint_match"] = c1 == c2
        if c1 != c2:
            problems.append(
                "checkint 不一致（%08x vs %08x）—— 内容被就地改过或截断" % (c1, c2))

        keytype, p = read_str(sec, p)
        info["private_key_type"] = keytype.decode(errors="replace")
        pubk, p = read_str(sec, p)
        priv, p = read_str(sec, p)
        info["public_part_len"] = len(pubk)
        info["private_part_len"] = len(priv)
        comment, p = read_str(sec, p)
        info["comment"] = comment.decode(errors="replace")

        pad = list(sec[p:])
        expect = list(range(1, len(pad) + 1))
        info["padding_ok"] = pad == expect
        info["padding_len"] = len(pad)
        if not info["padding_ok"]:
            problems.append("padding 不符合 1,2,3... 递增规则：%s" % pad)
    except ValueError as exc:
        problems.append("私有段解析失败：%s" % exc)

    return info, problems


def main():
    ap = argparse.ArgumentParser(description="诊断 SSH 私钥文件")
    ap.add_argument("path")
    ap.add_argument("--fix", action="store_true", help="修尾换行 / CRLF / 权限")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    path = os.path.expanduser(args.path)
    if not os.path.exists(path):
        print("文件不存在：%s" % path, file=sys.stderr)
        return 2

    raw = open(path, "rb").read()
    problems, fixes, info = [], [], {}

    info["path"] = path
    info["bytes"] = len(raw)
    info["mode"] = oct(os.stat(path).st_mode & 0o777)

    # ---- 权限
    if os.stat(path).st_mode & 0o077:
        problems.append("权限过宽（%s），ssh 会拒绝使用" % info["mode"])
        fixes.append("chmod 600 %s" % path)

    # ---- 行结构
    has_trailing_newline = raw.endswith(b"\n")
    info["ends_with_newline"] = has_trailing_newline
    if not has_trailing_newline:
        problems.append(
            "文件末尾缺换行符（\\n）—— 这是 'invalid format' 的头号原因；"
            "OpenSSH 按行解析 PEM，最后一行没有 \\n 会被丢弃，导致找不到 END 标记")
        fixes.append("printf '\\n' >> %s   # 或用 --fix" % path)

    info["has_crlf"] = b"\r\n" in raw
    if info["has_crlf"]:
        problems.append("包含 CRLF 行尾（Windows 换行），ssh 不认")
        fixes.append("sed -i '' 's/\\r$//' %s   # macOS；Linux 用 sed -i" % path)

    if raw[:1] in (b" ", b"\t"):
        problems.append("文件以空白开头（粘贴时带了缩进）")

    text = raw.decode("utf-8", errors="replace")
    lines = text.split("\n")
    first = lines[0].strip()
    last = next((l.strip() for l in reversed(lines) if l.strip()), "")

    m_begin = re.match(r"^-----BEGIN ([A-Z0-9 ]+)-----$", first)
    if not m_begin:
        print("第 1 行不是 PEM 头：%r" % first[:60], file=sys.stderr)
        return 2
    pem_label = m_begin.group(1)
    kind = PEM_TYPES.get(pem_label, "unknown")
    info["pem_label"] = pem_label
    info["pem_kind"] = kind

    m_end = re.match(r"^-----END ([A-Z0-9 ]+)-----$", last)
    if not m_end:
        problems.append(
            "找不到 END 行（末行是 %r）—— 通常就是末尾缺换行或内容被截断" % last[:40])
    elif m_end.group(1) != pem_label:
        problems.append("BEGIN/END 标签不匹配：%s vs %s" % (pem_label, m_end.group(1)))

    if kind == "unknown":
        print("不认识的 PEM 类型：%s" % pem_label, file=sys.stderr)
        return 2

    # ---- 只处理 OpenSSH 新格式
    if kind == "openssh":
        body = [
            l for l in lines
            if l and not l.startswith("-----")
        ]
        b64 = "".join(body).strip()
        bad = sorted({c for c in b64 if not re.match(r"[A-Za-z0-9+/=]", c)})
        info["base64_chars_ok"] = not bad
        if bad:
            problems.append("base64 正文含非法字符：%r" % bad[:10])

        try:
            blob = base64.b64decode(b64, validate=True)
        except Exception as exc:
            problems.append("base64 解码失败：%s" % exc)
            blob = b""

        if blob:
            info["decoded_bytes"] = len(blob)
            magic = blob[:15]
            info["magic_ok"] = magic == b"openssh-key-v1\x00"
            if not info["magic_ok"]:
                problems.append("magic 不是 openssh-key-v1：%r" % magic)
            else:
                try:
                    sub, subprob = analyze_openssh_payload(blob)
                    info.update(sub)
                    problems.extend(subprob)
                except ValueError as exc:
                    problems.append("容器解析失败：%s" % exc)
    else:
        info["note"] = "传统 PEM 格式（%s），由 ssh-keygen 直接校验" % kind

    # ---- 用 ssh-keygen 交叉验证
    import shutil
    import subprocess
    if shutil.which("ssh-keygen"):
        proc = subprocess.run(
            ["ssh-keygen", "-y", "-P", "", "-f", path],
            capture_output=True, text=True)
        info["ssh_keygen_ok"] = proc.returncode == 0
        if proc.returncode == 0:
            info["ssh_keygen_pubkey"] = proc.stdout.strip()
        else:
            err = (proc.stderr or proc.stdout).strip().splitlines()
            info["ssh_keygen_error"] = err[0] if err else ""
            if "invalid format" in info["ssh_keygen_error"]:
                problems.append("ssh-keygen 报 invalid format")
            elif "incorrect passphrase" in info["ssh_keygen_error"].lower():
                info["encrypted"] = True

    ok = info.get("ssh_keygen_ok") and not [
        p for p in problems if "缺换行" not in p and "权限" not in p and "CRLF" not in p
    ]

    if args.json:
        print(json.dumps({"ok": ok, "info": info, "problems": problems,
                          "fixes": fixes}, indent=2, ensure_ascii=False))
    else:
        print("文件      : %s" % path)
        print("大小/权限 : %d 字节 / %s" % (info["bytes"], info["mode"]))
        print("PEM 类型  : %s (%s)" % (pem_label, kind))
        if info.get("public_key_type"):
            print("密钥类型  : %s%s" % (
                info["public_key_type"],
                "（加密，需 passphrase）" if info.get("encrypted") else ""))
        if info.get("comment"):
            print("comment   : %s" % info["comment"])
        if info.get("ssh_keygen_ok"):
            print("公钥      : %s" % info["ssh_keygen_pubkey"])
        print()
        if problems:
            print("发现 %d 个问题：" % len(problems))
            for i, p in enumerate(problems, 1):
                print("  %d. %s" % (i, p))
        else:
            print("✅ 结构检查全部通过，ssh 可以正常使用这把私钥")

        if fixes:
            print("\n建议修复：")
            for f in fixes:
                print("  %s" % f)
            if args.fix:
                print("\n执行 --fix：")
                if not has_trailing_newline:
                    with open(path, "ab") as fh:
                        fh.write(b"\n")
                    print("  ✓ 已补末尾换行")
                if info["has_crlf"]:
                    data = open(path, "rb").read().replace(b"\r\n", b"\n")
                    open(path, "wb").write(data)
                    print("  ✓ 已转换 CRLF → LF")
                os.chmod(path, 0o600)
                print("  ✓ 权限已设为 600")
                print("\n修完请重跑本脚本确认")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
