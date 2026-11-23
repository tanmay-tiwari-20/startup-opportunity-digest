# Free private WhatsApp startup opportunities digest

Deployed at [tanmay-tiwari-20/startup-opportunity-digest](https://github.com/tanmay-tiwari-20/startup-opportunity-digest). The cloud linking test succeeded and was confirmed visible by the user. The old local Codex automation remains paused. The November 2026 collector upgrade prioritizes detailed opportunities and events.

The free route uses a public GitHub source-code repository and one standard Linux GitHub Actions job each day. It discovers and verifies official programme/event notices, adds supplementary startup news, sends to the authenticated account's **Message yourself** chat, saves encrypted state, and stops. The computer and Codex can be closed. There is no paid AI, search API or always-on hosting service.

The daily trigger is 6:30 PM IST. GitHub can delay or drop scheduled jobs, so this is a best-effort schedule rather than guaranteed delivery at an exact minute. Public-repository schedules can be disabled after 60 days without repository activity. See [GitHub scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Standard GitHub-hosted runners for public repositories are free. The workflow uses the repository's default cache allowance and creates no paid artifact storage, larger runners or external API calls. Current GitHub documentation lists a 10 GB cache allowance per repository; this small feed stores encrypted state and short public records well below that limit. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## What is included

- Up to six verified grants, programmes or events and two news/announcement items; available events and grants receive priority, with distinct issuer sites selected first.
- Forwardable opportunity posts with eligibility, support, financial conditions, full application deadlines, programme/event dates, application links and original sources.
- Current official programme records in `opportunity-seeds.json`, rechecked for issuer evidence and application availability every run.
- Bounded recurring discovery from official directories in `discovery-sources.json`, including readable notices and structured events. Discovered facts are reverified before selection.
- Supplementary news from YourStory, Inc42, UNCCD G20, Economic Times and TechCrunch, limited to 72 hours and one item per publisher per edition. Fresh items from less recently used publishers receive priority.
- Canonical article URLs remain suppressed when publication dates change; generic roundups and near-identical syndicated headlines are excluded.
- One labeled deadline reminder per opportunity version, after at least seven days and within its final seven days. Rolling calls do not repeat daily.
- A Baileys sender restricted to its own linked account, encrypted auth/outbox storage and reserved digest IDs.
- One scheduled workflow, with serialized runs and checks that stop delivery when the latest state is missing.

These counts are upper bounds: scarce fresh content is not filled with repeated stories. Total funding pools, conditional grants, investment and paid event passes retain their distinct meanings. Changed or conflicting issuer evidence, PDF-only or JavaScript-only notices, unreachable forms and unsupported fields enter review. Readable-page coverage remains narrower than a person or Codex researching the entire web; directory format changes may need maintenance. You choose which updates to forward.

## Verified locally

All 58 tests passed on 23 November 2026. They cover quotas, issuer diversity, changed article dates, syndicated headlines, rich rendering, current evidence, expiry, rolling calls, deadline reminders, stable preview IDs and recovery after an accepted send loses its collection checkpoint. The dry-run sends no WhatsApp message.

```sh
npm ci
npm test
node cloud-main.mjs --dry-run
```

The preview is saved under the ignored data/research/ directory. Normal runs use cloud-main.mjs --batch with the existing encrypted WhatsApp session. The workflow's optional `opportunity_preview=true` input uses a stable separate daily `-opportunities-v2` ID to send one upgraded preview; an accepted preview cannot be repeated. Normal daily IDs and cache paths are preserved.

## Deployment and linking

GitHub sign-in, repository creation, protected-secret configuration and a fresh WhatsApp linked device have been completed with user approval. Source code and the encrypted initial session are public; the decryption key is in GitHub Secrets and must never be committed or included in caches. The cloud session is separate from the previous laptop session.

The first bootstrap is complete and its one-time permission flag is now false. The active GitHub workflow triggers daily at 6:30 PM IST. Initialisation sent the cloud-connection confirmation and recorded a feed baseline. The user confirmed that message, and the old local schedule has been paused so only the cloud job sends daily updates.

The workflow never resets to an old initial session after a usable cloud run. GitHub cache storage is best effort; missing or stale state requires manual recovery and may require linking WhatsApp again. The cache contains encrypted auth/outbox files and public feed records, not the secret key or control token. Do not reuse stale credentials or bypass the send ledger after a failed run.

Baileys remains unofficial WhatsApp access and can break or lead to account restrictions. This package does not promise uninterrupted delivery or an official WhatsApp integration.

Initial validation: [linking run](https://github.com/tanmay-tiwari-20/startup-opportunity-digest/actions/runs/44776533188), [regular run](https://github.com/tanmay-tiwari-20/startup-opportunity-digest/actions/runs/44777325068). Both completed successfully. The daily trigger remains 6:30 PM IST; delivery follows the run and may be delayed by GitHub.
