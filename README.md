# Free private WhatsApp startup feed

Prepared 20 November 2026. This is the tested cloud deployment package; it has not yet been deployed or linked to a cloud WhatsApp session.

The free route uses a public GitHub source-code repository and one standard Linux GitHub Actions job each day. It collects public startup feeds and selected official call pages, sends a digest to the authenticated account's **Message yourself** chat, saves encrypted session state, and stops. There is no paid AI, search API or always-on hosting service.

The daily trigger is 6:30 PM IST. GitHub can delay or drop scheduled jobs, so this is a best-effort schedule rather than guaranteed delivery at an exact minute. Public-repository schedules can be disabled after 60 days without repository activity. See [GitHub scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Standard GitHub-hosted runners for public repositories are free. The workflow uses the repository's default cache allowance and creates no paid artifact storage, larger runners or external API calls. Current GitHub documentation lists a 10 GB cache allowance per repository; this small feed stores encrypted state and short public records well below that limit. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## What is included

- Public feeds from YourStory, Inc42 and the UNCCD G20 Global Land Initiative.
- Conservative official-page monitors for the two current ELEVATE calls and beVisioneers.
- Freshness checks, duplicate suppression, exact expiry where a closing time is known, source links and short source excerpts.
- A Baileys sender restricted to its own linked account, encrypted auth/outbox storage and reserved digest IDs.
- One scheduled workflow, with serialized runs and checks that stop delivery when the latest state is missing.

This API-free version has narrower coverage than the Codex research task. It presents source headlines/excerpts and configured call details; it does not perform an AI research sweep of every incubator. Add tested feed sources or an issuer-specific parser to expand coverage. A changed expected deadline is held for review rather than guessed. You choose which updates to forward.

## Verified locally

All 15 tests passed. A live collection checked all five configured source families, parsed 54 feed entries and selected eight updates. Both ELEVATE calls and the beVisioneers deadline parsed successfully. The preview sent no WhatsApp message.

```sh
npm ci
npm test
node cloud-main.mjs --dry-run
```

The preview is saved under the ignored data/research/ directory. Normal runs use cloud-main.mjs --batch and require a separately authorised, encrypted WhatsApp session.

## Deployment and linking

The remaining steps are to sign in to GitHub, create the public source repository, configure its protected authentication-key secret and approve a fresh WhatsApp linked device for the cloud job. Source code and the encrypted initial session can be public; the decryption key must remain in GitHub Secrets and must never be committed or included in caches. A fresh session avoids sharing mutable credentials with the still-running laptop relay.

Use the scheduled workflow's manual initialise option only for the first approved bootstrap. Initialisation sends a short cloud-connection confirmation and records a feed baseline. Then confirm the message in WhatsApp and switch off the old local schedule so only the cloud job sends daily updates.

The workflow never resets to an old initial session after a usable cloud run. GitHub cache storage is best effort; missing or stale state requires manual recovery and may require linking WhatsApp again. The cache contains encrypted auth/outbox files and public feed records, not the secret key or control token. Do not reuse stale credentials or bypass the send ledger after a failed run.

Baileys remains unofficial WhatsApp access and can break or lead to account restrictions. This package does not promise uninterrupted delivery or an official WhatsApp integration.

The existing local automation remains active until the cloud setup is linked and its test is confirmed.
