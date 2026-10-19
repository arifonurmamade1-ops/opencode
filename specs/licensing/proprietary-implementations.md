# Proprietary implementations policy

Status: active (FASE 31)

This repository is MIT-licensed and ships a product. We may study public
documentation, public feature descriptions, public APIs, standards, and public
behavior of other tools to derive functional requirements. We must implement
those requirements with our own architecture. Proprietary expression — code,
implementation, assets, marks, protected UI, closed components — is off limits.

## Allowed

- Reading public documentation, changelogs, API references, specifications,
  and public issue trackers to understand a feature.
- Deriving functional requirements and writing tests for our own design.
- Using dependencies that are compatible with this repository's MIT license
  (see the dependency policy below).
- Implementing an equivalent workflow with our own names, module boundaries,
  data flow, UI layout, and copy.

## Not allowed

- Copying source code or implementation details from proprietary software,
  including decompiled output, minified bundles, or private SDK internals.
- Copying proprietary assets: icons, illustrations, fonts, sounds, videos,
  sample data, or screenshots used as product assets.
- Using other products' trademarks, logos, or lookalike marks in a way that
  suggests affiliation or endorsement.
- Recreating protected UI pixel-for-pixel (layout, iconography, distinctive
  screens) from a proprietary product.
- Vendoring closed components or wrapping an unredistributable binary or SDK.
- Copying proprietary prompt text, marketing copy, or UX strings.
- Committing license headers or notices that claim another owner's rights.

## Implementing an equivalent

1. Record the public sources you studied in the PR description.
2. Write the requirement as behavior (inputs, outputs, edge cases) without
   referring to the original implementation.
3. Design the module in this codebase's own terms and reuse our patterns.
4. Add tests that pin the behavior.
5. Run `bun run license:audit` before opening the PR.
6. For new assets, record the origin and license in the PR.

## Dependency licenses

`bun run license:audit` classifies every installed dependency and our workspace
manifests. `--strict` also fails on review items.

| Class     | Licenses                                                                                                                                | Action                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| allowed   | MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0, WTFPL, Zlib, BSL-1.0, OFL-1.1, CC-BY-3.0/4.0 | keep copyright/NOTICE attribution                                        |
| review    | MPL-2.0, LGPL-2.1/3.0, EPL, CDDL, AFL, Artistic-2.0, FSL-1.1-MIT, CC-BY-SA                                                              | record a rationale before merging; do not bundle when the terms conflict |
| forbidden | GPL-2.0/3.0, AGPL-3.0, SSPL, BUSL, Elastic-2.0, CC-BY-NC, UNLICENSED, proprietary                                                       | do not add                                                               |

SPDX expressions follow standard composition: `OR` is satisfied by any allowed
branch; `AND` needs every component allowed. A missing declaration is a review
item, never a silent pass. The audit falls back to the package `LICENSE` file
when the manifest omits a license.

## Assets and marks

- New assets must state origin and license in the PR. Bundled OFL fonts keep
  their license file.
- Do not ship competitor logos or screenshots as product assets. Documentation
  screenshots may be used only when the source permits it and attribution is
  present.
- Do not use another product's name in a way that implies endorsement.

## UI and components

- UI is designed from our own layout, tokens, icons, and copy. Do not trace or
  pixel-match a proprietary interface.
- Closed components are replaced by our own implementation or an allowed
  dependency, never by a wrapper around an unredistributable binary.

## Enforcement

```
bun run license:audit            # dependencies + tracked sources
bun run license:audit --strict   # also fail on dependencies needing review
```

CI runs the non-strict audit on every push. A finding is a merge blocker:
replace the dependency or asset, rewrite the copied text, or document a
reviewed exception in the PR. Update the allowlist in
`packages/opencode/src/licensing/audit.ts` only when the license terms justify
it.

The source scan intentionally skips license files, documentation, tests, and
binary assets: they may legally contain third-party copyright text. It flags
notices such as "all rights reserved", "confidential and proprietary",
"unauthorized copying", and "do not distribute" in shipped source text.

## Review checklist

- [ ] Feature requirements came from public information.
- [ ] Implementation, names, and structure are original.
- [ ] New dependencies are allowed or reviewed.
- [ ] New assets record origin and license.
- [ ] No competitor marks or protected UI in shipped artifacts.
- [ ] `bun run license:audit` passes; review items have a recorded rationale.
