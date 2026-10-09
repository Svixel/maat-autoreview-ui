# Curated judge exemplars

Each JSON file is a schema-validated curated precedent. An available
`screenshot` pins `libraryPath` to a run-qualified `runs/<run-id>/...png` path
and supplies its SHA-256 digest; it must never point through mutable `latest/`.
During pack construction, while the project library lease is held, those exact
bytes are copied into the pack build and added to `attachmentHashes`. The judge
verifies the packed attachment digest immediately before it calls an engine.

Use `status: "unavailable"` with a concrete `reason` when the image is not
retained in the library. Do not guess a replacement path or use a current
`latest/` image; unavailable precedent metadata remains visible but has no
image attachment.

This keeps review evidence out of both the skill and the reviewed project.
