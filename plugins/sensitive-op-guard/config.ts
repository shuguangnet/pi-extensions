/**
 * 高敏操作门禁配置
 *
 * 修改这里的正则即可自定义"哪些路径算敏感文件"、"哪些命令算删除/读取敏感操作"。
 * 改完 `/reload` 或重启 pi 生效。
 */

/**
 * 敏感文件路径匹配（作用于 `read`/`edit`/`write` 工具的 path 参数，
 * 以及 bash 命令里出现的文件路径 token）。
 *
 * 命中即需要用户确认后才能继续；未命中照常放行。
 */
export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  // .env 及变体：.env / .env.local / .env.production / .env.development ...
  /(^|\/)\.env(\.[\w.-]+)?$/,
  // 常见密钥文件
  /(^|\/)(secrets?|credentials?|tokens?)\.(json|ya?ml|toml|ini|env)$/i,
  /(^|\/)service-?account[a-z0-9-]*\.json$/i, // GCP 服务账号
  /(^|\/)(google|gcp)[-_].*\.json$/i,
  // 私钥 / 证书 / 凭据
  /(^|\/)(id_rsa|id_ed25519|id_dsa)(\.pub)?$/,
  /(^|\/)(\.)ssh\//,
  /(^|\/)(\.)aws\//,
  /(^|\/)(\.)gnupg\//,
  /\.(pem|p12|pfx|key)$/i,
];

/**
 * bash 里的"删除/破坏性"命令（需确认）。
 */
export const DELETE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b/, // rm / rm -rf / rm -r / rm -f ...
  /\brmdir\b/,
  /\bunlink\b/,
  /\bgit\s+rm\b/,
  /\bfind\b[\s\S]*?\s+-delete\b/,
  /\bshred\b/,
  /\bdd\s+if=.*\bof=\S+/i, // 覆写磁盘 / 文件（可能破坏数据）
  /\b(mv|cp)\b[\s\S]*\b(trash|\.Trash|~)\b/, // 移动到回收站类（可选，保守可关闭）
];

/**
 * bash 里"读取文件类"命令名（用于识别"用 cat/grep 读敏感文件"的场景）。
 */
export const READ_COMMAND_PATTERNS: RegExp[] = [
  /\b(cat|grep|head|tail|less|more|sed|awk|sort|wc|strings|xxd|od|diff|md5|sha\d+sum)\b/i,
];

/**
 * 是否开启"拦截写入/编辑敏感文件"（默认关闭，按需开启）。
 * 开启后 edit/write 命中的敏感路径同样需要确认。
 */
export const GUARD_WRITE = false;
