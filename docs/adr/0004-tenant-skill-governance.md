# ADR 0004: Tenant-owned Skill governance

## Status

Accepted — phase 1

## Context

Global Pi Skills belong to the installation and are not a safe extension point for
multiple tenants. A tenant-uploaded Skill may contain prompt-injection text or
scripts, so upload must not imply execution or host access.

## Decision

The Tenant Skill bounded context owns upload, validation, immutable versions,
review, activation, suspension, assignment, and audit. A personal declarative
version is visible only to its uploading membership and is activated immediately.
Agent startup resolves that membership's active Skill set and command execution
remains inside the tenant Agent Sandbox.

Phase 1 accepts ZIP packages containing `SKILL.md`, static resources, scripts,
and runtime metadata such as package manifests or Dockerfiles. Uploading those
files does not install dependencies or execute them. Skills are mounted
read-only in the Agent Sandbox, which keeps host execution, network, and secrets
unavailable. Declarative Skills can be activated by their uploader; versions
containing scripts remain drafts until Admin/Owner publishes them. Admin
governance visibility is separate from the normal personal Skill list.

## Consequences

- The host-wide Skill registry remains installation-owned.
- Published content is tenant- and membership-scoped and cannot cross user or tenant lookups.
- Versions are never edited in place, making rollback and audit possible.
- Dependency installation, network capabilities, and secret brokers are deferred
  until a separate capability policy exists.
