export const Categories = [
  "secrets",
  "dependencies",
  "vulnerabilities",
  "injection",
  "xss",
  "ssrf",
  "rce",
  "path-traversal",
  "auth",
  "permissions",
  "data-exposure",
] as const

export type Category = (typeof Categories)[number]

export const Severities = ["critical", "high", "medium", "low", "info"] as const

export type Severity = (typeof Severities)[number]

export interface Finding {
  readonly rule: string
  readonly category: Category
  readonly severity: Severity
  readonly message: string
  readonly hint: string
  readonly file: string
  readonly line: number
  readonly column: number
  readonly snippet: string
}

export interface Rule {
  readonly id: string
  readonly category: Category
  readonly severity: Severity
  readonly message: string
  readonly hint: string
  readonly pattern: RegExp
  readonly extensions?: readonly string[]
  readonly file?: RegExp
  readonly near?: RegExp
  readonly ignore?: RegExp
  readonly capture?: number
  readonly secret?: boolean
}

const CODE = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "astro",
  "html",
  "htm",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "php",
  "cs",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "yml",
  "yaml",
  "toml",
  "json",
]

const PACKAGE_JSON = /(?:^|\/)package\.json$/

const PLACEHOLDER =
  /(?:\$\{|<[a-z-]+>|process\.env|os\.environ|import\.meta|changeme|placeholder|example|sample|dummy|redacted|^x{4,}|^\*{3,}|^\s*$|^your|^my[_-]|^foo$|^bar$|^test|^fake|^password$|^passwd$|^secret$|^token$)/i

export const rules: readonly Rule[] = [
  {
    id: "secret-private-key",
    category: "secrets",
    severity: "critical",
    message: "Private key material committed to the repository",
    hint: "Remove the key, rotate it, and load it from a secret manager or environment variable.",
    pattern: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY-----/,
    secret: true,
  },
  {
    id: "secret-aws-access-key",
    category: "secrets",
    severity: "critical",
    message: "Hardcoded AWS access key",
    hint: "Remove the key, rotate it, and load it from the environment or a secret manager.",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
    secret: true,
  },
  {
    id: "secret-github-token",
    category: "secrets",
    severity: "critical",
    message: "Hardcoded GitHub token",
    hint: "Remove the token, revoke it on GitHub, and use environment-based authentication.",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    secret: true,
  },
  {
    id: "secret-stripe-live-key",
    category: "secrets",
    severity: "critical",
    message: "Hardcoded Stripe live key",
    hint: "Remove the key, roll it in the Stripe dashboard, and load it from the environment.",
    pattern: /\b[sr]k_live_[0-9a-zA-Z]{16,}\b/,
    secret: true,
  },
  {
    id: "secret-openai-key",
    category: "secrets",
    severity: "high",
    message: "Hardcoded API key with an OpenAI-like shape",
    hint: "Remove the key, rotate it, and load it from the environment.",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    ignore: /(?:example|test|placeholder|xxxx)/i,
    secret: true,
  },
  {
    id: "secret-google-api-key",
    category: "secrets",
    severity: "high",
    message: "Hardcoded Google API key",
    hint: "Remove the key, restrict or rotate it in Google Cloud, and load it from the environment.",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    secret: true,
  },
  {
    id: "secret-slack-token",
    category: "secrets",
    severity: "high",
    message: "Hardcoded Slack token",
    hint: "Remove the token, revoke it in Slack, and load it from the environment.",
    pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/,
    secret: true,
  },
  {
    id: "secret-database-url",
    category: "secrets",
    severity: "high",
    message: "Connection string with an embedded credential",
    hint: "Move the credential to the environment and rotate it.",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]+@/,
    ignore: /(?:\$\{|<[a-z-]+>|example|user:pass|:password@|:pass@|:secret@|:redacted@)/i,
    secret: true,
  },
  {
    id: "secret-jwt",
    category: "secrets",
    severity: "medium",
    message: "JWT-looking value embedded in the source",
    hint: "Confirm whether this is a real credential or a test fixture; real tokens must be revoked and moved out of the code.",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/,
    secret: true,
  },
  {
    id: "secret-generic-assignment",
    category: "secrets",
    severity: "low",
    message: "Value assigned to a credential-named variable",
    hint: "Verify whether the value is a real credential; if so, move it to the environment and rotate it.",
    pattern:
      /(?:api[_-]?key|apikey|client[_-]?secret|secret|token|passwd|password|credential|private[_-]?key)\s*[:=]\s*["']([^"'\n]{8,})["']/i,
    ignore: PLACEHOLDER,
    capture: 1,
    secret: true,
  },
  {
    id: "dependency-unpinned",
    category: "dependencies",
    severity: "info",
    message: 'Dependency version is not pinned ("latest" or "*")',
    hint: "Pin the dependency to a version range so installs are reproducible.",
    pattern: /"\s*:\s*"(?:latest|\*)"/,
    extensions: ["json"],
    file: PACKAGE_JSON,
  },
  {
    id: "dependency-unsafe-install-script",
    category: "dependencies",
    severity: "medium",
    message: "Install script downloads or executes remote code",
    hint: "Review the script: lifecycle scripts that pipe remote content into a shell are a supply-chain risk.",
    pattern: /"(?:pre|post)?(?:install|prepare)"\s*:\s*"[^"]*(?:curl|wget|Invoke-WebRequest|rm\s+-rf|chmod\s+\+x|\|\s*(?:sh|bash|zsh))/i,
    extensions: ["json"],
    file: PACKAGE_JSON,
  },
  {
    id: "vulnerability-new-buffer",
    category: "vulnerabilities",
    severity: "medium",
    message: "Deprecated Buffer constructor",
    hint: "new Buffer() is deprecated and removed in modern Node; use Buffer.from() or Buffer.alloc().",
    pattern: /\bnew Buffer\s*\(/,
    extensions: CODE,
  },
  {
    id: "vulnerability-broken-crypto",
    category: "vulnerabilities",
    severity: "high",
    message: "Deprecated and insecure crypto API",
    hint: "createCipher/createDecipher derive the key unsafely; use createCipheriv/createDecipheriv with a real key and IV.",
    pattern: /\bcreateCipher\s*\(|\bcreateDecipher\s*\(/,
    extensions: CODE,
  },
  {
    id: "vulnerability-weak-hash",
    category: "vulnerabilities",
    severity: "high",
    message: "Weak hash function used in a security-sensitive context",
    hint: "MD5/SHA-1 are not collision resistant; use SHA-256 or better, and a password hashing algorithm for passwords.",
    pattern: /\b(?:md5|sha1)\s*\(|\bcreateHash\s*\(\s*["'](?:md5|sha1)["']/i,
    near: /(?:password|passwd|salt|credential|secret|session|token)/i,
    extensions: CODE,
  },
  {
    id: "vulnerability-math-random-secret",
    category: "vulnerabilities",
    severity: "medium",
    message: "Math.random() used near security-sensitive naming",
    hint: "Math.random() is not cryptographically secure; use a CSPRNG (crypto.randomUUID/randomBytes) for tokens, salts and identifiers.",
    pattern: /\bMath\.random\s*\(\s*\)/,
    near: /(?:token|secret|salt|nonce|session|otp|csrf|reset|key|password)/i,
    extensions: CODE,
  },
  {
    id: "rce-eval",
    category: "rce",
    severity: "high",
    message: "Dynamic code execution with eval",
    hint: "Confirm the input can never be attacker-controlled; prefer a parser or a sandboxed evaluator.",
    pattern: /\beval\s*\(/,
    extensions: CODE,
  },
  {
    id: "rce-new-function",
    category: "rce",
    severity: "high",
    message: "Dynamic code compilation with new Function",
    hint: "Confirm the source string can never be attacker-controlled; prefer static functions or a sandboxed evaluator.",
    pattern: /\bnew\s+Function\s*\(/,
    extensions: CODE,
  },
  {
    id: "rce-shell-interpolation",
    category: "rce",
    severity: "high",
    message: "Shell command built with interpolation or concatenation",
    hint: "Pass arguments as an array without a shell, or validate against a strict allowlist; never interpolate untrusted input.",
    pattern: /\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\([^)]*(?:\$\{|["'`]\s*\+\s*[A-Za-z_$])/,
    extensions: CODE,
  },
  {
    id: "rce-python-shell",
    category: "rce",
    severity: "high",
    message: "Shell command execution in Python",
    hint: "Avoid os.system and shell=True; pass argument lists and validate inputs.",
    pattern: /\bos\.system\s*\(|\bsubprocess\.(?:run|call|check_output|check_call|Popen)\s*\([^)]*shell\s*=\s*True/,
    extensions: ["py"],
  },
  {
    id: "injection-sql-interpolation",
    category: "injection",
    severity: "medium",
    message: "SQL statement built with interpolation or concatenation",
    hint: "Use parameterized queries; confirm whether the interpolated value is user-controlled (tagged template builders like drizzle sql`` parameterize safely).",
    pattern: /(?:\bSELECT\b[^'"`;]{0,120}\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b)[^'"`;]{0,120}(?:\$\{|["'`]\s*\+\s*[A-Za-z_$])/i,
    extensions: CODE,
  },
  {
    id: "injection-raw-query",
    category: "injection",
    severity: "medium",
    message: "Raw query built with interpolation or concatenation",
    hint: "Use the parameterized form of the query API; confirm whether the interpolated value is user-controlled.",
    pattern: /\.(?:raw|unsafe|query|execute)\s*\([^)]*(?:\$\{|["'`]\s*\+\s*[A-Za-z_$])/i,
    extensions: CODE,
  },
  {
    id: "xss-dangerously-set-inner-html",
    category: "xss",
    severity: "high",
    message: "Raw HTML rendering through dangerouslySetInnerHTML",
    hint: "Sanitize the HTML with a vetted sanitizer (for example DOMPurify) before rendering, or render text instead.",
    pattern: /dangerouslySetInnerHTML/,
    extensions: CODE,
  },
  {
    id: "xss-inner-html-assignment",
    category: "xss",
    severity: "high",
    message: "HTML written through an innerHTML/outerHTML assignment",
    hint: "Use textContent or a vetted sanitizer; innerHTML parses and executes embedded markup.",
    pattern: /\.(?:inner|outer)HTML\s*=(?![=>])/,
    extensions: CODE,
  },
  {
    id: "xss-document-write",
    category: "xss",
    severity: "medium",
    message: "Document written with document.write",
    hint: "document.write injects raw markup; build DOM nodes instead.",
    pattern: /document\.write(?:ln)?\s*\(/,
    extensions: CODE,
  },
  {
    id: "xss-template-directive",
    category: "xss",
    severity: "high",
    message: "Template directive that renders raw HTML",
    hint: "Template bindings like v-html and [innerHTML] parse raw HTML; sanitize the input or render text instead.",
    pattern: /\bv-html\s*=|\[innerHTML\]\s*=|\{@html\s/,
    extensions: CODE,
  },
  {
    id: "ssrf-user-url",
    category: "ssrf",
    severity: "high",
    message: "Outbound request to a value derived from request input",
    hint: "Validate the destination against an allowlist and block internal addresses (localhost, private ranges, metadata endpoints).",
    pattern:
      /\b(?:fetch|axios(?:\.\w+)?|got|ky|superagent|undici\.request|http\.(?:get|request)|https\.(?:get|request)|request)\s*\(\s*(?:`[^`]*\$\{\s*)?\b(?:req|request|params|query|body|payload|input|url|uri|target|webhook|callback)\b/,
    extensions: CODE,
  },
  {
    id: "ssrf-open-redirect",
    category: "ssrf",
    severity: "medium",
    message: "Redirect target derived from request input",
    hint: "Restrict redirect targets to a fixed allowlist to prevent open redirects.",
    pattern: /\.redirect\s*\(\s*(?:req|request|params|query|body)\b/,
    extensions: CODE,
  },
  {
    id: "traversal-path-join-user-input",
    category: "path-traversal",
    severity: "medium",
    message: "Filesystem path built from incoming input",
    hint: "Resolve the final path and verify it stays inside the intended root; reject names containing path separators or '..'.",
    pattern: /\bpath\.(?:join|resolve|normalize)\s*\([^)]*\b(?:req|request|params|query|body|payload|upload|filename)\b\./,
    extensions: CODE,
  },
  {
    id: "traversal-fs-user-path",
    category: "path-traversal",
    severity: "medium",
    message: "Filesystem operation on a value derived from incoming input",
    hint: "Verify the resolved path stays inside the intended root before reading or writing.",
    pattern:
      /\b(?:fs|fsp|fsPromises)\.(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|appendFile|unlink|unlinkSync|rm|rmSync|open|openSync|readdir|readdirSync|stat|statSync)\s*\([^)]*\b(?:req|request|params|query|body|payload|upload|filename)\b\./,
    extensions: CODE,
  },
  {
    id: "traversal-send-file-user-input",
    category: "path-traversal",
    severity: "medium",
    message: "File response built from incoming input",
    hint: "Verify the resolved path stays inside the intended root before sending the file.",
    pattern: /\.(?:sendFile|download|downloadFile)\s*\([^)]*\b(?:req|request|params|query|body)\b\./,
    extensions: CODE,
  },
  {
    id: "auth-jwt-none-algorithm",
    category: "auth",
    severity: "critical",
    message: "JWT verification accepts the \"none\" algorithm",
    hint: "Require a strong algorithm and always verify the signature.",
    pattern: /algorithm[s]?\s*[:=]\s*\[?\s*["']none["']/i,
    extensions: CODE,
  },
  {
    id: "auth-jwt-ignore-expiration",
    category: "auth",
    severity: "high",
    message: "JWT expiration check disabled",
    hint: "Accepting expired tokens removes a core token safeguard; re-enable expiration checks.",
    pattern: /ignoreExpiration\s*:\s*true/,
    extensions: CODE,
  },
  {
    id: "auth-tls-verification-disabled",
    category: "auth",
    severity: "high",
    message: "TLS certificate verification disabled",
    hint: "Disabling certificate validation enables man-in-the-middle attacks; fix the trust chain instead.",
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
    extensions: CODE,
  },
  {
    id: "auth-jwt-decode-only",
    category: "auth",
    severity: "medium",
    message: "JWT decoded without signature verification",
    hint: "jwt.decode does not verify the signature; confirm the token is verified elsewhere before trusting its claims.",
    pattern: /\bjwt\.decode\s*\(|\bdecodeJwt\s*\(|\bdecodeToken\s*\(/,
    extensions: CODE,
  },
  {
    id: "auth-bcrypt-low-rounds",
    category: "auth",
    severity: "medium",
    message: "Password hashing with a low work factor",
    hint: "Use at least 10 bcrypt rounds (12 is the common baseline).",
    pattern: /\b(?:genSalt|genSaltSync)\s*\(\s*[1-9]\s*[,)]|\b(?:hash|hashSync)\s*\([^,]+,\s*[1-9]\s*[,)]/,
    extensions: CODE,
  },
  {
    id: "permission-world-writable",
    category: "permissions",
    severity: "medium",
    message: "World-writable permission mode",
    hint: "Grant the minimum permissions needed; 777 exposes the file to every user on the system.",
    pattern: /\b0o?7{3}\b|\bchmod\s+(?:-R\s+)?7{3}\b/,
  },
  {
    id: "exposure-log-secret",
    category: "data-exposure",
    severity: "medium",
    message: "Potential secret or credential written to logs",
    hint: "Log an identifier or a masked value instead of the credential itself.",
    pattern:
      /\b(?:console\.\w+|print|println|fmt\.Print\w*|System\.out\.println|log\.[A-Za-z]+|logger\.[A-Za-z]+)\s*\([^)]*\b(?:password|passwd|secret|token|api[_-]?key|apikey|credential|authorization|cookie)\b/i,
    extensions: CODE,
  },
  {
    id: "exposure-stack-trace",
    category: "data-exposure",
    severity: "medium",
    message: "Stack trace sent to the client",
    hint: "Stack traces leak implementation details; return a generic error and log the trace server-side.",
    pattern: /\.(?:send|json|end|write)\s*\([^)]*\.stack\b/,
    extensions: CODE,
  },
  {
    id: "exposure-env-dump",
    category: "data-exposure",
    severity: "medium",
    message: "Entire process environment serialized",
    hint: "Environment dumps expose every secret in the process; select only the variables you need.",
    pattern: /(?:JSON\.stringify|Object\.(?:keys|entries)|console\.log|print)\s*\(\s*process\.env\b/,
    extensions: CODE,
  },
]

const MAX_LINE_LENGTH = 600
const MAX_FINDINGS_PER_RULE = 25

export function scan(input: { file: string; content: string; categories?: readonly Category[] }): Finding[] {
  const file = input.file.replaceAll("\\", "/")
  const dot = file.lastIndexOf(".")
  const extension = dot === -1 ? "" : file.slice(dot + 1).toLowerCase()
  const active = rules.filter((rule) => {
    if (input.categories && !input.categories.includes(rule.category)) return false
    if (rule.extensions && !rule.extensions.includes(extension)) return false
    if (rule.file && !rule.file.test(file)) return false
    return true
  })
  if (active.length === 0) return []

  const findings: Finding[] = []
  const counts = new Map<string, number>()
  const lines = input.content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.length === 0 || line.length > MAX_LINE_LENGTH) continue
    for (const rule of active) {
      if ((counts.get(rule.id) ?? 0) >= MAX_FINDINGS_PER_RULE) continue
      if (rule.near && !rule.near.test(line)) continue
      const match = rule.pattern.exec(line)
      if (!match) continue
      const value = (rule.capture === undefined ? match[0] : match[rule.capture]) ?? match[0]
      if (rule.ignore?.test(value)) continue
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1)
      findings.push({
        rule: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: rule.message,
        hint: rule.hint,
        file,
        line: index + 1,
        column: match.index + 1,
        snippet: rule.secret ? compact(line.split(value).join(mask(value))) : compact(line),
      })
    }
  }
  return findings
}

export function summarize(findings: readonly Finding[]) {
  return {
    total: findings.length,
    severities: Severities.map((severity) => ({
      severity,
      count: findings.filter((finding) => finding.severity === severity).length,
    })),
    categories: Categories.map((category) => ({
      category,
      count: findings.filter((finding) => finding.category === category).length,
    })),
  }
}

export function severityRank(severity: Severity) {
  return Severities.indexOf(severity)
}

function mask(value: string) {
  if (value.length <= 10) return "*".repeat(Math.max(6, value.length))
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

function compact(value: string) {
  const line = value.trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

export * as SecurityScanner from "./scanner"
