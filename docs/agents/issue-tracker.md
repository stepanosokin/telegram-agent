# Issue tracker

Track specs and tickets in GitHub Issues for `stepanosokin/telegram-agent`. Run `gh` from the checkout or pass `--repo stepanosokin/telegram-agent` to issue commands.

## Issue operations

- Publish a spec or ticket with `gh issue create --title "..." --body-file <file>`.
- Fetch a ticket with `gh issue view <number> --json number,title,body,labels,comments`.
- List tickets with `gh issue list --state open --json number,title,body,labels,comments`. Apply `--label` and `--state` as needed.
- Create a sub-issue with `gh issue create --parent <number> ...` or link an existing one with `gh issue edit <parent> --add-sub-issue <child>`. If sub-issues are unavailable, add `Part of #<parent>` to the child body.
- Comment with `gh issue comment <number> --body-file <file>`.
- Apply or remove labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Close a ticket with `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When enabled, triage external PRs with the same vocabulary. Use `gh pr view`, `gh pr diff`, `gh pr comment`, `gh pr edit`, and `gh pr close`. To resolve an ambiguous `#<number>`, try `gh pr view <number>` before `gh issue view <number>`.

## Wayfinding

- Put notes, decisions so far, and open questions in one issue labelled `wayfinder:map`.
- Link each ticket as a sub-issue and apply `wayfinder:<type>`. Create the relevant wayfinding label if absent. If sub-issues are unavailable, add a task list entry in the map and `Part of #<map>` in the child.
- Record dependencies with `gh api --method POST repos/stepanosokin/telegram-agent/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Get the blocker's database ID with `gh api repos/stepanosokin/telegram-agent/issues/<blocker> --jq .id`. If native dependencies are unavailable, list blockers as `Blocked by: #<number>` near the top of the ticket.
- Select an open, unblocked, unclaimed child. Assign it to yourself with `gh issue edit <number> --add-assignee @me` before starting work.
- Record the resolution with `gh issue comment <number> --body-file <file>`, close the child, and add the outcome and a link to the map's decisions.
