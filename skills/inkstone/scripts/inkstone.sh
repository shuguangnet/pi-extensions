#!/usr/bin/env bash
# Inkstone 知识库 MCP 命令行包装（无状态 JSON-RPC，无需 session）
#
# 凭据加载顺序（不在本文件中硬编码）:
#   1. 环境变量 INKSTONE_MCP_TOKEN
#   2. 本 skill 目录下的 .token 文件（已 gitignore）
#
# 用法:
#   inkstone.sh <tool> ['<arguments-json>']
#   inkstone.sh tools                  # 列出全部工具
# 示例:
#   inkstone.sh list_folders
#   inkstone.sh search_notes '{"query":"tailscale","limit":5}'
#   inkstone.sh read_note '{"note_id":"<id>","max_chars":8000}'
#   inkstone.sh ask_notes '{"query":"内网穿透方案对比"}'
#
# 输出为 MCP result 的原始 JSON（单行）。非零退出码 = 请求失败。
set -euo pipefail

BASE="${INKSTONE_MCP_URL:-https://md.933999.xyz/mcp}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${INKSTONE_MCP_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$SCRIPT_DIR/.token" ]]; then
  TOKEN="$(tr -d '[:space:]' < "$SCRIPT_DIR/.token")"
fi
if [[ -z "$TOKEN" && -f "$SCRIPT_DIR/../.token" ]]; then
  TOKEN="$(tr -d '[:space:]' < "$SCRIPT_DIR/../.token")"
fi
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: 缺少凭据。请设置 INKSTONE_MCP_TOKEN 环境变量，或在 $SCRIPT_DIR/.token 写入 Token" >&2
  exit 2
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tool> [json-args] | $0 tools" >&2
  exit 2
fi

if [[ "$1" == "tools" ]]; then
  PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
else
  TOOL="$1"
  ARGS="${2-}"
  if [[ -z "$ARGS" ]]; then ARGS='{}'; fi
  printf -v PAYLOAD '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$TOOL" "$ARGS"
fi

RESP=$(curl -fsS -m 60 -X POST "$BASE" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$PAYLOAD") || { echo "REQUEST_FAILED: 服务不可达或认证失败" >&2; exit 1; }

# 响应为 SSE 格式时取 data: 行；纯 JSON 响应则原样输出
if [[ "$RESP" == *'data: '* ]]; then
  echo "$RESP" | grep '^data: ' | sed 's/^data: //'
else
  echo "$RESP"
fi
