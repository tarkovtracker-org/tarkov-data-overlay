# Story publication recovery

`data/eft/story-write.lock` serializes publication of
`src/additions/storyChapters.json5` and `scripts/story-reference.lock.json`.
A stopped writer or an unconfirmed rollback retains this exclusive lock so
another writer cannot publish over an unresolved artifact/provenance pair.
Do not delete it just because its process has stopped.

The first line is the writer PID (diagnostic only; PIDs can be reused). Before
replacing the artifact, the writer appends a versioned JSON recovery record:

- `artifact`: project-relative artifact path.
- `snapshot`: project-relative hard-link snapshot path, or `null` when there was
  no previous artifact.
- `artifactSha256`: SHA-256 of the exact rendered artifact this run intended to
  publish, not the generator's input JSON.
- `previousArtifactSha256`: SHA-256 of the previous artifact, or `null` for
  previous absence.
- `previousPinSha256`: SHA-256 of the previous provenance lock's complete bytes,
  or `null` for previous absence. This is not the capture hash inside that lock.

The record contains no capture contents or provider details. It is written into
the already-open exclusive lock before replacement, so a full disk cannot force
the writer to allocate recovery metadata after failure. Snapshot cleanup errors
after confirmed promotion or rollback only warn and release the exclusive lock;
any leftover snapshot directory can be removed after verifying the pair.

## Manual verified recovery

1. Stop all story writers and prevent new runs. Confirm the writer is stopped
   using process inspection, not just the PID's existence or absence. Correct
   disk-space, filesystem or permission failures before touching retained files.
2. Read the recovery record locally. Validate that its paths refer to the
   expected project files and that the snapshot, when present, is inside the
   artifact's rollback directory. Hash files with `sha256sum` without editing
   them. Keep the exclusive lock in place throughout recovery.
3. Compare the current provenance lock with `previousPinSha256`. If it differs,
   is unreadable, or was expected to be absent but now exists, preserve everything
   and investigate which publication it describes. Do not restore the snapshot
   under a changed pin. Likewise, preserve foreign artifact bytes: an artifact
   matching neither the recorded output nor the recorded previous artifact must
   not be overwritten or deleted.
4. With the previous pin verified unchanged:
   - If the artifact already matches `previousArtifactSha256`, the old pair is
     intact (for example, interruption before replacement). Verify any retained
     snapshot against that same hash.
   - If a previous artifact existed and the current artifact matches
     `artifactSha256` or is absent, verify the snapshot against
     `previousArtifactSha256`, then rename that verified snapshot over the
     artifact on the same filesystem. Do not copy unverified bytes.
   - If no previous artifact existed, remove the current artifact only when its
     hash equals `artifactSha256`; an already-absent artifact needs no removal.
5. Recheck that the artifact has its recorded previous hash (or is absent as
   recorded), and that the provenance lock still has its recorded previous hash
   (or is absent as recorded). Remove any remaining verified snapshot directory,
   then remove `data/eft/story-write.lock` **last**. Retry generation only after
   the pair is reconciled.

If the metadata is missing or incomplete, or any required file is unreadable or
has an unexpected hash, retain the lock and all evidence. Establish the correct
pair from reviewed repository history and staged provenance before any cleanup.
An interrupted writer may have completed promotion; a changed pin requires
independent verification of that completed pair rather than an automatic
rollback. There is no automatic recovery or stale-lock deletion.
