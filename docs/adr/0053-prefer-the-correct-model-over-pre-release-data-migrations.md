# Prefer the correct model over pre-release data migrations

No functional Stash Instance currently contains user data, so the redesign may replace incompatible schemas, ownership rules, and development seed data without implementing migrations from the current prototype model. This temporarily narrows ADR-0022: forward-compatible migrations remain a release requirement once Stash has a functional release or real user data, but preserving an unused prototype schema must not distort the first correct product model.
