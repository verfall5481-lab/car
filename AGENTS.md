# Deriro development instructions

## Coordination

- The primary agent owns orchestration, integration review, and acceptance verification.
- The user requested implementation agents use `gpt-6.1-sol` with `xhigh` reasoning. Use that configuration for delegated implementation.
- Assign non-overlapping file ownership before parallel changes. Do not overwrite another agent's work.
- Work in this local repository. Hosting, real external integrations, and GitHub publication are separate milestones.

## Product authority

- Read `docs/SPEC.md` before changing behavior. Version 0.4 section 23 supersedes earlier child-only terminology and models.
- `docs/references/` contains the user's 29 supplied boards, including repeated and variant boards. Keep the supplied design direction.
- The submission DOCX contains personal application data and is not a source-code asset. Do not copy it into the tracked repository.
- Use Korean UI copy through a copy module. Mobile: white backgrounds, charcoal text/actions, amber accents. Vehicle: dark backgrounds, large type, amber primary actions.
- Do not portray demo maps, authentication, notifications, vehicle data, or navigation as real integrations.

## Correctness

- Real pickup state transitions must occur in authenticated server RPC transactions, never direct client table updates.
- A handoff retains the current assignee until the recipient accepts. Arrival is not boarding completion.
- A navigation failure must not undo departure. Validate arrival callbacks against the current vehicle navigation session and destination revision.
- Never infer sufficient driving range from incomplete distance data.
- Use family-scoped authorization and cross-family foreign keys. Never expose privileged service keys to clients.
- Pin exact dependency versions and keep lockfiles. Follow the SPEC dependency release-age rule.

## Verification

- Run relevant type checks, production builds, and meaningful state-machine tests.
- Check the rider-to-guardian-to-vehicle demo journey in the browser when available.
- Report separately: verified local behavior, unverified native/SDK behavior, and unconnected external services.
