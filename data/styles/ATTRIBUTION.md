# Attribution

The looks in this directory are **not ours**. They are the AI Visual Prompt
Cookbook by [VigoZhao](https://github.com/VigoZhao), used under the MIT License.

- Upstream: https://github.com/VigoZhao/AI-Visual-Prompt-Cookbook
- Pinned commit: `8b6068f4d65e5efac12ab6e9794a2f8c2a73cc60`
- Licence: MIT — `Copyright (c) 2026 VigoZhao` (full text in `LICENSE`)
- Styles vendored: 137
- `stylesSha256`: `dec1551e389a983b86957b7c3f12a9c26c4c489d5f661b18c535881ad2f8b850`

Each style carries its upstream `style_name`, `style_version` and category in its
`source` block, and every result brushrouter returns from this library reports
them. `scripts/vendor-styles.mjs` re-fetches at the pinned commit and refuses to
write if the canonical hash changes.

We normalize the shape — `STYLE_FIDELITY_ANCHORS` becomes `styleLock`,
`SOURCE_CONTENT_TO_AVOID` becomes `doNotClone`, variables are lowercased — but the
prompt text, anchors, exclusions and negatives are reproduced as upstream wrote
them. Nothing here is paraphrased.

If you redistribute these styles, carry this file and `LICENSE` with them.
