# Free private WhatsApp startup feed

Deployed and verified 20 November 2026 at [tanmay-tiwari-20/startup-opportunity-digest](https://github.com/tanmay-tiwari-20/startup-opportunity-digest). The cloud linking test succeeded and was confirmed visible by the user. A regular run restored encrypted state, sent six source updates and saved the new state successfully. The old local Codex automation is paused.

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

GitHub sign-in, repository creation, protected-secret configuration and a fresh WhatsApp linked device have been completed with user approval. Source code and the encrypted initial session are public; the decryption key is in GitHub Secrets and must never be committed or included in caches. The cloud session is separate from the previous laptop session.

The first bootstrap is complete and its one-time permission flag is now false. The active GitHub workflow triggers daily at 6:30 PM IST. Initialisation sent the cloud-connection confirmation and recorded a feed baseline. The user confirmed that message, and the old local schedule has been paused so only the cloud job sends daily updates.

The workflow never resets to an old initial session after a usable cloud run. GitHub cache storage is best effort; missing or stale state requires manual recovery and may require linking WhatsApp again. The cache contains encrypted auth/outbox files and public feed records, not the secret key or control token. Do not reuse stale credentials or bypass the send ledger after a failed run.

Baileys remains unofficial WhatsApp access and can break or lead to account restrictions. This package does not promise uninterrupted delivery or an official WhatsApp integration.

Validation: [initial cloud run](https://github.com/tanmay-tiwari-20/startup-opportunity-digest/actions/runs/44776533188), [regular cloud run](https://github.com/tanmay-tiwari-20/startup-opportunity-digest/actions/runs/44777325068). Both completed successfully. The next daily trigger is 21 November 2026 at 6:30 PM IST; delivery follows the run and may be delayed by GitHub.
