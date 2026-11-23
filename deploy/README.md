# Private WhatsApp digest deployment

The active deployment is a scheduled GitHub Actions batch in the approved public code repository. It collects public sources, connects the paired WhatsApp account, sends its private digest to that same account, saves updated encrypted state, and exits. No AI API key or continuously running laptop is required. Bootstrap and linking are already complete; content updates use the current session and cache.

## Before activation

Review the worker, relay, source rules, package lock, and workflow together. The repository must contain `cloud-main.mjs`, `relay.mjs`, `ui.html`, `package.json`, `package-lock.json`, and the collector's referenced source configuration. The local relay is a separate installation and has not been changed by these deployment assets.

The cloud relay needs `DATA_DIR` support: its configuration directory must become `path.join(DATA_DIR, 'config')`, with the original local path used when `DATA_DIR` is absent. In Docker only, `WHATSAPP_RELAY_BIND_HOST=0.0.0.0` permits access through Docker's port mapping; the host publishes that port on `127.0.0.1` only. GitHub Actions should keep the relay itself bound to `127.0.0.1`.

The worker accepts `--batch`, reads `AUTH_KEY_BASE64`, generates or reads an ephemeral local `CONTROL_TOKEN`, and handles the initial `DIGEST_INITIALIZE_ONLY=true` by establishing a baseline and sending the approved connection confirmation. It flushes encrypted auth/outbox writes before exiting. It never accepts an arbitrary recipient and must not retry a digest with an uncertain send outcome.

## Approve and bootstrap once

Account session material is sensitive even when encrypted. Creating or uploading a cloud bootstrap requires the user's explicit approval of the destination repository and the paired session to use. Prefer a fresh, separately approved linked session for cloud execution; do not silently copy the current local session. Keep the existing local publisher active until the cloud pilot has passed, then disable its schedule as the deliberate final cutover step to avoid two daily digests.

After that approval, add only the approved `auth-state.enc` and `outbox.enc` to `bootstrap/`. Never add the raw encryption key, control token, plaintext credentials, QR image, or account identifiers. In a public repository the encrypted files can be downloaded by anyone; authenticated AES-GCM encryption and a secret, random 32-byte key are therefore essential. The worker must reject decryption failures and must not reset the auth or send ledger.

Register the matching key as the repository Secret `AUTH_KEY_BASE64` through GitHub's Secrets settings. Never put its value in chat, a workflow file, a shell command recorded in history, or a log. `CONTROL_TOKEN` is optional if the worker generates a new private token each batch. Repository writers must be trusted because they can change code that runs with secrets.

First-run bootstrap is complete and `BOOTSTRAP_ONLY_FIRST_RUN` is false. Do not toggle it for a collector upgrade. Subsequent daily runs restore the latest cache; scheduled runs never use the old bootstrap automatically. Manual reinitialization of a previously running workflow is a separate recovery operation requiring a current state snapshot and review of previously sent digests.

## Schedule and state

The schedule is `0 13 * * *` in UTC, which corresponds to 6:30 PM India time. GitHub scheduling is best effort: runs can start late or be dropped during load. In public repositories, scheduled workflows can be disabled after 60 days without repository activity. This option should not be represented as guaranteed delivery at exactly 6:30 PM or as a perpetual unattended service.

The workflow permits only default-branch schedule and manual runs, pins official actions to verified full commit SHAs, uses read-only repository/API permissions, and serializes runs with cancellation disabled. Do not add pull-request triggers that execute this worker with the key.

Only these paths are cached:

- `data/config/auth-state.enc`
- `data/config/outbox.enc`
- `data/seen.json`, containing public source identifiers and hashes only
- `data/digests/`, containing public opportunity summaries only

Do not write account keys, raw credentials, QR data, personal chats, or secrets to the public ledger or digest directory. `auth-key.bin` and `control-token.txt` are deliberately outside the cache allowlist. The key remains in GitHub Secrets and the worker reconstructs local configuration only inside the ephemeral runner.

GitHub caches are not durable databases. Entries unused for more than seven days can be evicted; the default repository storage limit is 10 GB. Keep the default limit, do not opt into paid cache expansion, and bound public history growth. A missing cache or a cache older than the latest completed run blocks sending rather than restoring a stale outbox. An interrupted runner can still lose its last state update; inspect the private WhatsApp chat before recovery or rerunning after a state-save failure.

The cache-save action can report upload failures as warnings. The workflow therefore verifies that the current run's exact cache key exists afterward. That verification confirms retention of a cache entry, not that a phone received its message.

Before posting a digest, the worker saves its candidate public collection as a pending transaction under `data/digests/`. On every reconnect it reconciles pending transactions across dates: accepted sends restore the candidate shared-item history; uncertain reservations block all new editions; unreserved snapshots are discarded for fresh research. This prevents a lost post-send checkpoint from making accepted articles or calls appear new on the next day. A content preview uses a separate stable daily ID and the same reconciliation rules.

## Validate before cutover

Check that a test digest appears only in the account's self chat; that a second attempt with the same digest ID produces no new message; that lost collection checkpoints reconcile accepted reservations; and that a timeout or missing/stale cache does not cause an automatic resend. Phone push notifications from a self chat require a live test. Baileys is unofficial and session or protocol changes may require maintenance or re-pairing.

Run duration, repository visibility, billing settings, cache size, and GitHub's current plan limits determine whether this remains within free allowances. Use standard Linux hosted runners and no paid API. This is a free-tier candidate, not a permanent zero-cost guarantee.

## Optional Docker host

The Docker files are an alternative for an already available Linux Docker host, not a free hosting provider. They run one batch and exit; `restart: "no"` prevents a completed batch from immediately repeating. A host scheduler must launch the container daily at 18:30 `Asia/Kolkata`. A small persistent Linux VPS can support this design, but it may carry a hosting cost; no provider price is assumed here.

The named `/data` volume is initialized for non-root UID 1000 and contains all mutable files. Protect and back up the encryption key separately. Use only one worker against a state volume. The container filesystem is otherwise read-only and its optional UI port is exposed on the host's loopback interface only.

If a separately approved pairing UI is running on a remote Docker host, access it through an SSH local forward to `127.0.0.1:18764`; do not publish the pairing UI or QR on the internet. The tunnel is needed for pairing and inspection, not for daily collection. The batch workflow itself does not provide a remote pairing UI.

## Primary references

- [GitHub scheduled-workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub cache limits, access rules, and eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- [GitHub workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use)
- [Official cache action](https://github.com/actions/cache/releases/tag/v6.1.0)
- [Baileys session management](https://baileys.wiki/authentication/session-management)
