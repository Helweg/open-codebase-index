# Issue tracker: GitHub

Issues, specs, and tickets live in `Helweg/open-codebase-index`. Use `gh` with `--repo Helweg/open-codebase-index` to avoid targeting another remote. Creating issues or labels requires user authorization.

- Publish: `gh issue create --title "…" --body-file <file>`. Apply the requested label at creation.
- Fetch: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list` with the relevant `--state` and `--label` filters.
- Update: use `gh issue edit`, `gh issue comment`, or `gh issue close` as appropriate. When closing with an explanation, post it before closing.
- Sub-issues and blockers: use GitHub's native parent relationships and issue dependencies. If unavailable, use explicit `Part of #<number>` or `Blocked by: #<number>` references in the body. A ticket is unblocked only when its blockers are closed.
- Wayfinding: label the parent issue `wayfinder:map` and its child tickets `wayfinder:<type>` where configured. Claim an unblocked child by assigning it; on resolution, close the child and link the decision from the map.

**PRs as a request surface: no.**
