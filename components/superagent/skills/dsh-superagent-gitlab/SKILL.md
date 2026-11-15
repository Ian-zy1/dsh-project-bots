---
name: dsh-superagent-gitlab
description: Work with the configured GitLab project, Issue conversations and merge requests.
---

Use the configured `glab` wrapper and the `DSH_SUPERAGENT_GITLAB_*` environment values. All work belongs to this installation's single project. Keep the agent account separate from human requesters; the agent's own events are ignored.

Read `gitlab/issues/<iid>` or `gitlab/merge_requests/<iid>` with `orchestrator_read` for the original record; append `/notes` for comments. GitLab Issue `#12` and MR `!12` are different objects. Read source files with `gitlab/file/<path>` or directories with `gitlab/directory/<path>`.

Use `glab mr create` to propose delivery. Use a branch whose last path segment is `DSH_SUPERAGENT_NAME`. Immediately report the MR with `orchestrator_report` and `mr_iid`; this binds the MR lifecycle to the Ticket. Use the source MR when the task began from an MR. A ready report is not merge or human acceptance. Respect repository rules and explicit merge authorization.

Use the acknowledgement and report tools for messages to the task's requesters. Do not post duplicate acknowledgements with raw CLI calls. Never print credentials or use a different account.
