// Pre-publish redaction, leak scanning, and validation command safety checks.

const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
  /sk-proj-[A-Za-z0-9\-_]{20,}/g,
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /"?token"?\s*[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi,
  /api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi,
  /secret\s*[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi,
  /password\s*[=:]\s*["']?[^\s"',;)}\]]{6,}["']?/gi,
  /gh[pous]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /xox[baprsv]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]{20,}/g,
  /AccountKey=[^;\s]+/gi,
  /client_secret=[A-Za-z0-9~._\-]{8,}/gi,
  /instrumentationkey=[0-9a-fA-F-]{20,}/gi,
  /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  /(?<=:\/\/)[^@\s]+:[^@\s]+(?=@)/g,
  /\/home\/[^\s"',;)}\]]+/g,
  /\/Users\/[^\s"',;)}\]]+/g,
  /[A-Z]:\\Users\\[^\s"',;)}\]]+/g,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  /\.env\.[a-zA-Z]+\b/g,
  /(?<=[\\/])\.env\b/g,
];

const REDACT_ALLOWLIST = [
  /^\/home\/runner(?:[/]|$)/,
  /^\/Users\/runner(?:[/]|$)/,
  /^\/home\/circleci(?:[/]|$)/,
  /^\/home\/vsts(?:[/]|$)/,
  /^(?:noreply|no-reply|donotreply|do-not-reply)@(?:github\.com|users\.noreply\.github\.com|gitlab\.com|bitbucket\.org)$/i,
  /^[a-zA-Z0-9.+_-]+@users\.noreply\.github\.com$/i,
  /^git@(?:github|gitlab|bitbucket)\.(?:com|org)$/i,
];

const LEAK_SCANNERS = [
  { type: "api_key", pattern: /sk-(?:proj-|ant-)?[A-Za-z0-9\-_]{20,}/g, suggest: "process.env.API_KEY" },
  { type: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g, suggest: "process.env.AWS_ACCESS_KEY_ID" },
  { type: "github_token", pattern: /(?:gh[pous]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, suggest: "process.env.GITHUB_TOKEN" },
  { type: "npm_token", pattern: /npm_[A-Za-z0-9]{36,}/g, suggest: "process.env.NPM_TOKEN" },
  { type: "slack_token", pattern: /xox[baprsv]-[A-Za-z0-9-]{10,}/g, suggest: "process.env.SLACK_TOKEN" },
  { type: "jwt", pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]{20,}/g, suggest: "process.env.JWT" },
  { type: "azure_secret", pattern: /(?:AccountKey=[^;\s]+|client_secret=[A-Za-z0-9~._\-]{8,}|instrumentationkey=[0-9a-fA-F-]{20,})/gi, suggest: "process.env.AZURE_SECRET" },
  { type: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]{20,}=*/g, suggest: "process.env.AUTH_TOKEN" },
  { type: "private_key", pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, suggest: "process.env.PRIVATE_KEY_PATH" },
  { type: "db_url", pattern: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s"',;)}\]]{10,}/gi, suggest: "process.env.DATABASE_URL" },
  { type: "local_path", pattern: /(?:\/home\/[a-zA-Z0-9_.-]+\/|\/Users\/[a-zA-Z0-9_.-]+\/|[A-Z]:\\Users\\[a-zA-Z0-9_.-]+\\)/g, suggest: "<user-home>" },
  { type: "internal_ip", pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?::\d{2,5})?\b/g, suggest: "<internal-host>" },
  { type: "basic_auth", pattern: /:\/\/[^@\s:]+:[^@\s]+@/g, suggest: "process.env.SERVICE_URL" },
];

const ENV_SCAN_SKIP_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "SHELL", "TERM", "LANG", "USER", "USERNAME", "LOGNAME",
  "PWD", "OLDPWD", "SHLVL", "HOSTNAME", "COMPUTERNAME", "DISPLAY", "EDITOR",
  "PAGER", "LESS", "COLORTERM", "TERM_PROGRAM", "COMSPEC", "SYSTEMROOT", "WINDIR",
  "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA",
  "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
  "GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR", "GITHUB_REPOSITORY_OWNER",
]);

function isNonSecretEnvKey(key) {
  return ENV_SCAN_SKIP_KEYS.has(key) || key.startsWith("npm_");
}

const REDACTED = "[REDACTED]";

function isAllowlisted(match) {
  return REDACT_ALLOWLIST.some((re) => re.test(match));
}

export function redactString(str) {
  if (typeof str !== "string") return str;
  let result = str;
  for (const pattern of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => (isAllowlisted(match) ? match : REDACTED));
  }
  return result;
}

export function sanitizePayload(value) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const cleanKey = redactString(String(key)) || REDACTED;
    out[cleanKey] = sanitizePayload(val);
  }
  return out;
}

export function scanForLeaks(input) {
  const content = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (!content) return { found: false, leaks: [] };
  const leaks = [];
  const seen = new Set();
  for (const scanner of LEAK_SCANNERS) {
    scanner.pattern.lastIndex = 0;
    let match;
    while ((match = scanner.pattern.exec(content)) !== null) {
      const val = match[0];
      if (isAllowlisted(val)) continue;
      const key = `${scanner.type}:${val}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaks.push({
        type: scanner.type,
        value: val.length > 60 ? `${val.slice(0, 57)}...` : val,
        suggestion: scanner.suggest,
      });
    }
  }
  return { found: leaks.length > 0, leaks };
}

export function detectEnvValueLeaks(input, env = process.env) {
  const content = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (!content) return [];
  const leaks = [];
  for (const [key, val] of Object.entries(env)) {
    if (!val || val.length < 8) continue;
    if (isNonSecretEnvKey(key)) continue;
    if (/^(\/|[A-Za-z]:\\|[a-z][a-z0-9+.-]*:\/\/)/i.test(val)) continue;
    if (content.includes(val)) {
      leaks.push({
        type: "env_value_leak",
        envKey: key,
        value: val.length > 60 ? `${val.slice(0, 57)}...` : val,
        suggestion: `process.env.${key}`,
      });
    }
  }
  return leaks;
}

export function fullLeakCheck(input, env = process.env) {
  const scan = scanForLeaks(input);
  const envLeaks = detectEnvValueLeaks(input, env);
  const leaks = scan.leaks.concat(envLeaks);
  return { found: leaks.length > 0, leaks };
}

// Restricts validation commands to safe test runners without shell chaining.
export function isValidationCommandAllowed(command) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  if (/`|\$\(/.test(trimmed)) return false;
  const unquoted = trimmed.replace(/"[^"]*"|'[^']*'/g, "");
  if (/[;&|><]/.test(unquoted)) return false;
  return /^(?:node|npm|npx|pytest|dotnet|cargo)\b|^go\s+test\b/.test(trimmed);
}
