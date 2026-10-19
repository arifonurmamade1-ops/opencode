import { describe, expect, test } from "bun:test"
import { LicenseAudit } from "@/licensing/audit"

function classOf(expression: string | undefined): LicenseAudit.LicenseClass {
  return LicenseAudit.classifyLicense(expression).class
}

describe("license classification", () => {
  test("accepts permissive licenses and aliases", () => {
    expect(classOf("MIT")).toBe("allowed")
    expect(classOf("mit")).toBe("allowed")
    expect(classOf("MIT-0")).toBe("allowed")
    expect(classOf("MIT/X11")).toBe("allowed")
    expect(classOf("ISC")).toBe("allowed")
    expect(classOf("BSD-2-Clause")).toBe("allowed")
    expect(classOf("BSD-3-Clause")).toBe("allowed")
    expect(classOf("Apache-2.0")).toBe("allowed")
    expect(classOf("0BSD")).toBe("allowed")
    expect(classOf("Unlicense")).toBe("allowed")
    expect(classOf("CC0-1.0")).toBe("allowed")
    expect(classOf("BlueOak-1.0.0")).toBe("allowed")
    expect(classOf("Python-2.0")).toBe("allowed")
    expect(classOf("WTFPL")).toBe("allowed")
    expect(classOf("Zlib")).toBe("allowed")
    expect(classOf("OFL-1.1")).toBe("allowed")
  })

  test("keeps weak copyleft and source-available licenses in review", () => {
    expect(classOf("MPL-2.0")).toBe("review")
    expect(classOf("LGPL-2.1-only")).toBe("review")
    expect(classOf("LGPL-3.0-or-later")).toBe("review")
    expect(classOf("EPL-2.0")).toBe("review")
    expect(classOf("CDDL-1.1")).toBe("review")
    expect(classOf("Artistic-2.0")).toBe("review")
    expect(classOf("FSL-1.1-MIT")).toBe("review")
    expect(classOf("CC-BY-SA-4.0")).toBe("review")
    expect(classOf("SEE LICENSE IN LICENSE")).toBe("review")
  })

  test("rejects strong copyleft, non-commercial, and undeclared licenses", () => {
    expect(classOf("GPL-2.0")).toBe("forbidden")
    expect(classOf("GPL-2.0+")).toBe("forbidden")
    expect(classOf("GPL-3.0-only")).toBe("forbidden")
    expect(classOf("AGPL-3.0-or-later")).toBe("forbidden")
    expect(classOf("SSPL-1.0")).toBe("forbidden")
    expect(classOf("BUSL-1.1")).toBe("forbidden")
    expect(classOf("CC-BY-NC-4.0")).toBe("forbidden")
    expect(classOf("UNLICENSED")).toBe("forbidden")
    expect(classOf(undefined)).toBe("review")
    expect(LicenseAudit.classifyLicense(undefined).reason).toContain("no license declared")
  })

  test("resolves OR expressions through any allowed branch", () => {
    expect(classOf("MIT OR Apache-2.0")).toBe("allowed")
    expect(classOf("GPL-3.0-only OR MIT")).toBe("allowed")
    expect(classOf("GPL-3.0-only OR AGPL-3.0-only")).toBe("forbidden")
    expect(classOf("MPL-2.0 OR GPL-3.0-only")).toBe("review")
    expect(classOf("AFL-2.1 OR BSD-3-Clause")).toBe("allowed")
    expect(classOf("WTFPL OR ISC")).toBe("allowed")
  })

  test("requires every component of AND expressions to be acceptable", () => {
    expect(classOf("Apache-2.0 AND BSD-3-Clause")).toBe("allowed")
    expect(classOf("MIT AND MPL-2.0")).toBe("review")
    expect(classOf("GPL-3.0-only AND MIT")).toBe("forbidden")
    expect(classOf("Apache-2.0 AND LGPL-3.0-or-later")).toBe("review")
  })

  test("parses parentheses and OR/AND precedence", () => {
    expect(classOf("(MIT OR Apache-2.0) AND BSD-3-Clause")).toBe("allowed")
    expect(classOf("MIT OR (Apache-2.0 AND MPL-2.0)")).toBe("allowed")
    expect(classOf("MIT OR Apache-2.0 AND BSD-3-Clause")).toBe("allowed")
    expect(LicenseAudit.parseLicenseExpression("MIT OR Apache-2.0 AND BSD-3-Clause")).toEqual({
      type: "or",
      left: { type: "license", id: "MIT" },
      right: {
        type: "and",
        left: { type: "license", id: "Apache-2.0" },
        right: { type: "license", id: "BSD-3-Clause" },
      },
    })
  })

  test("handles license exceptions", () => {
    expect(classOf("Apache-2.0 WITH LLVM-exception")).toBe("allowed")
    expect(classOf("GPL-2.0-only WITH Classpath-exception-2.0")).toBe("review")
    expect(classOf("MIT WITH Some-custom-exception")).toBe("review")
  })

  test("never silently accepts malformed or non-SPDX expressions", () => {
    expect(classOf("MIT OR")).toBe("review")
    expect(classOf("MIT AND")).toBe("review")
    expect(classOf("(MIT")).toBe("review")
    expect(classOf("Apache License 2.0")).toBe("review")
    expect(classOf("")).toBe("review")
    expect(LicenseAudit.classifyLicense("Apache License 2.0").reason).toContain("unrecognized")
  })
})

describe("license text inference", () => {
  test("recognizes common permissive license texts", () => {
    expect(LicenseAudit.inferLicenseFromText("MIT License\n\nPermission is hereby granted, free of charge")).toBe("MIT")
    expect(
      LicenseAudit.inferLicenseFromText(
        "ISC License\n\nPermission to use, copy, modify, and/or distribute this software",
      ),
    ).toBe("ISC")
    expect(LicenseAudit.inferLicenseFromText("Apache License\nVersion 2.0, January 2004")).toBe("Apache-2.0")
    expect(LicenseAudit.inferLicenseFromText("Redistribution and use in source and binary forms, with")).toBe(
      "BSD-2-Clause",
    )
    expect(
      LicenseAudit.inferLicenseFromText(
        "Redistribution and use in source and binary forms, with\nNeither the name of the copyright holder",
      ),
    ).toBe("BSD-3-Clause")
    expect(LicenseAudit.inferLicenseFromText("BSD Zero Clause License")).toBe("0BSD")
    expect(LicenseAudit.inferLicenseFromText("Blue Oak Model License")).toBe("BlueOak-1.0.0")
    expect(
      LicenseAudit.inferLicenseFromText("This is free and unencumbered software released into the public domain."),
    ).toBe("Unlicense")
    expect(LicenseAudit.inferLicenseFromText("CC0 1.0 Universal")).toBe("CC0-1.0")
    expect(LicenseAudit.inferLicenseFromText("SIL OPEN FONT LICENSE Version 1.1")).toBe("OFL-1.1")
  })

  test("recognizes copyleft and source-available license texts", () => {
    expect(LicenseAudit.inferLicenseFromText("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007")).toBe("GPL-3.0")
    expect(LicenseAudit.inferLicenseFromText("GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991")).toBe("GPL-2.0")
    expect(LicenseAudit.inferLicenseFromText("GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3")).toBe("AGPL-3.0")
    expect(LicenseAudit.inferLicenseFromText("GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1")).toBe("LGPL-2.1")
    expect(LicenseAudit.inferLicenseFromText("Mozilla Public License Version 2.0")).toBe("MPL-2.0")
    expect(LicenseAudit.inferLicenseFromText("Functional Source License, Version 1.1, MIT Future License")).toBe(
      "FSL-1.1-MIT",
    )
  })

  test("flags unknown and all-rights-reserved texts", () => {
    expect(LicenseAudit.inferLicenseFromText("Copyright 2024 Acme. All rights reserved.")).toBe("proprietary")
    expect(classOf("proprietary")).toBe("forbidden")
    expect(LicenseAudit.inferLicenseFromText("Terms available on request.")).toBeUndefined()
    expect(LicenseAudit.inferLicenseFromText("")).toBeUndefined()
  })
})

describe("source marker scan", () => {
  test("reports each proprietary notice with its line and marker", () => {
    const text = [
      "// Copyright 2024 Acme. All rights reserved.",
      "export const ok = 1",
      "// Confidential and proprietary.",
      "// Do not copy this file.",
      "// must not be distributed",
      "// for internal use only",
    ].join("\n")
    const hits = LicenseAudit.scanSourceText(text)
    expect(hits.map((hit) => hit.line)).toEqual([1, 3, 4, 5, 6])
    expect(hits.map((hit) => hit.marker)).toEqual([
      "all-rights-reserved",
      "confidential-proprietary",
      "do-not-distribute",
      "do-not-distribute",
      "internal-use-only",
    ])
    expect(hits[0].snippet).toBe("// Copyright 2024 Acme. All rights reserved.")
  })

  test("ignores words that only look like markers", () => {
    const text = [
      "// confidentialité — a privacy setting",
      "// this is proprietary information",
      "// copied values are fine",
      "const distribution = 1",
    ].join("\n")
    expect(LicenseAudit.scanSourceText(text)).toEqual([])
  })

  test("detects past-tense distribution notices", () => {
    expect(
      LicenseAudit.scanSourceText("This file must not be copied or redistributed").map((hit) => hit.marker),
    ).toEqual(["do-not-distribute"])
  })
})

describe("source path selection", () => {
  test("scans shipped source text", () => {
    expect(LicenseAudit.shouldScanSource("packages/opencode/src/index.ts")).toBe(true)
    expect(LicenseAudit.shouldScanSource("packages\\opencode\\src\\tool\\bash.txt")).toBe(true)
    expect(LicenseAudit.shouldScanSource("packages/opencode/src/view.tsx")).toBe(true)
    expect(LicenseAudit.shouldScanSource(".github/workflows/test.yml")).toBe(true)
  })

  test("skips docs, tests, license files, lockfiles, and assets", () => {
    expect(LicenseAudit.shouldScanSource("packages/opencode/test/tool/task.test.ts")).toBe(false)
    expect(LicenseAudit.shouldScanSource("packages/opencode/src/foo.spec.ts")).toBe(false)
    expect(LicenseAudit.shouldScanSource("specs/licensing/proprietary-implementations.md")).toBe(false)
    expect(LicenseAudit.shouldScanSource("packages/web/src/content/docs/go.mdx")).toBe(false)
    expect(LicenseAudit.shouldScanSource("LICENSE")).toBe(false)
    expect(LicenseAudit.shouldScanSource("packages/app/THIRD-PARTY-NOTICES.md")).toBe(false)
    expect(LicenseAudit.shouldScanSource("bun.lock")).toBe(false)
    expect(LicenseAudit.shouldScanSource("packages/app/public/logo.png")).toBe(false)
    expect(LicenseAudit.shouldScanSource("packages/app/public/assets/font.woff2")).toBe(false)
    expect(LicenseAudit.shouldScanSource("node_modules/effect/index.js")).toBe(false)
    expect(LicenseAudit.shouldScanSource("packages/opencode/dist/index.js")).toBe(false)
  })
})

describe("dependency audit", () => {
  test("classifies declared licenses and deduplicates by name and version", () => {
    const entries = LicenseAudit.auditDependencies([
      { name: "a", version: "1.0.0", license: "MIT" },
      { name: "a", version: "1.0.0", license: "GPL-3.0-only" },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: "a", license: "MIT", class: "allowed", source: "manifest" })
  })

  test("falls back to the license file when the manifest omits a license", () => {
    const entries = LicenseAudit.auditDependencies([
      {
        name: "b",
        version: "2.0.0",
        licenseText: "MIT License\n\nPermission is hereby granted, free of charge",
      },
    ])
    expect(entries[0]).toMatchObject({ license: "MIT", class: "allowed", source: "license-file" })
  })

  test("keeps undeclared packages in review and forbidden packages forbidden", () => {
    const entries = LicenseAudit.auditDependencies([
      { name: "c", version: "3.0.0" },
      { name: "d", version: "4.0.0", license: "UNLICENSED" },
    ])
    expect(entries[0]).toMatchObject({ class: "review", source: "missing", license: undefined })
    expect(entries[1]).toMatchObject({ class: "forbidden", license: "UNLICENSED" })
  })
})

describe("audit report", () => {
  test("collects source findings and counts scanned files", () => {
    const audit = LicenseAudit.auditSources([
      { path: "src/a.ts", text: "export const a = 1" },
      { path: "src/b.ts", text: "// All rights reserved." },
    ])
    expect(audit.scanned).toBe(2)
    expect(audit.items).toHaveLength(1)
    expect(audit.items[0].path).toBe("src/b.ts")
    expect(audit.items[0].hits[0].line).toBe(1)
  })

  test("passes a clean tree and fails on forbidden licenses or markers", () => {
    const clean = LicenseAudit.buildAuditReport(
      LicenseAudit.auditDependencies([{ name: "a", version: "1.0.0", license: "MIT" }]),
      { scanned: 3, items: [] },
    )
    expect(clean.dependencies).toMatchObject({ total: 1, allowed: 1, review: 0, forbidden: 0 })
    expect(clean.verdict).toBe("pass")
    expect(LicenseAudit.auditExitCode(clean)).toBe(0)

    const forbidden = LicenseAudit.buildAuditReport(
      [
        {
          name: "g",
          version: "1.0.0",
          license: "GPL-3.0-only",
          class: "forbidden",
          reason: "strong copyleft",
          source: "manifest",
        },
      ],
      { scanned: 1, items: [] },
    )
    expect(forbidden.verdict).toBe("fail")
    expect(LicenseAudit.auditExitCode(forbidden)).toBe(1)
    expect(LicenseAudit.formatAuditReport(forbidden)).toContain("forbidden dependencies")
    expect(LicenseAudit.formatAuditReport(forbidden)).toContain("g@1.0.0")

    const flagged = LicenseAudit.buildAuditReport([], {
      scanned: 1,
      items: [
        { path: "src/x.ts", hits: [{ line: 4, marker: "all-rights-reserved", snippet: "// All rights reserved." }] },
      ],
    })
    expect(flagged.verdict).toBe("fail")
    expect(LicenseAudit.auditExitCode(flagged)).toBe(1)
    expect(LicenseAudit.formatAuditReport(flagged)).toContain("src/x.ts:4")
  })

  test("review items only fail with --strict", () => {
    const review = LicenseAudit.buildAuditReport(
      [
        {
          name: "mpl",
          version: "2.0.0",
          license: "MPL-2.0",
          class: "review",
          reason: "weak copyleft",
          source: "manifest",
        },
      ],
      { scanned: 1, items: [] },
    )
    expect(review.verdict).toBe("pass")
    expect(LicenseAudit.auditExitCode(review)).toBe(0)
    expect(LicenseAudit.auditExitCode(review, { strict: true })).toBe(1)
    expect(LicenseAudit.formatAuditReport(review, { strict: true })).toContain("verdict: FAIL")
    expect(LicenseAudit.formatAuditReport(review, { strict: true })).toContain("--strict: 1 review item(s)")
    expect(LicenseAudit.formatAuditReport(review)).toContain("MPL-2.0 - 1 package(s)")
    expect(LicenseAudit.formatAuditReport(review)).not.toContain("mpl")
    expect(LicenseAudit.formatAuditReport(review, { verbose: true })).toContain("mpl")
  })
})
