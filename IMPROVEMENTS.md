# TinyEnginy: codebase improvements and technical roadmap

| | |
|---|---|
| **Status** | Proposal, for discussion |
| **Author** | Adam Olšer |
| **Date** | 2026-11-06 |
| **Related** | #4 (CSV country codes), #5 (email verification), #6 (enrich phone, draft), #1 (gender guessing review) |

## Context

This list comes from working through the take-home tasks: two bug fixes, the enrich-phone workflow and a PR review. Every item was found in this repo, and the **Evidence** line says where. Line numbers refer to `main` at `6e16908` unless stated otherwise.

**Effort** is a rough estimate: **S** is up to a day, **M** is 2–5 days, **L** is more than a week.

**🎙️** marks a point I raised during the screen-recorded session. Unmarked points came from the code analysis.

## Summary

| # | Item | Horizon | Effort | Why now | 🎙️ |
|---|---|---|---|---|---|
| 1 | Make `main` verifiable: lint, type check, CI, commit linting, PR template | Now | S | Two broken checks already reached `main` unnoticed | 🎙️ |
| 2 | One pattern for third-party calls (Temporal + start-and-poll) | Now | M | The email-verification hang and PR #1 have the same root cause | 🎙️ |
| 3 | Validate input at the API boundary | Now | M | The frontend parser is the only validation for most fields | 🎙️ |
| 4 | Small production-hygiene fixes | Now | S | Cheap, and they remove real risks | 🎙️ |
| 5 | Backfill and normalise existing country data | Now | S | #4 only validates new imports; old rows keep bad values | 🎙️ |
| 6 | Provider resilience: rate limits, cancellation, stuck runs | Next | M | Providers have announced rate limits | |
| 7 | Provider contract tests | Next | S | The README's Nimbus contract is already wrong | |
| 8 | Environments and secrets management | Next | M | Config and keys are per-machine `.env` files with no production story | 🎙️ |
| 9 | One source of truth for lead fields and reference data | Next | M | Fields are about to grow, and lists are already duplicated | 🎙️ |
| 10 | Correct and fast bulk import | Next | M | Duplicate detection is name-only and imports one row at a time | |
| 11 | Split `index.ts` into routers | Next | M | 323 lines today, and every feature adds to it | 🎙️ |
| 12 | Developer experience: seed data, test tooling, Node version | Next | S | Recurring friction during this work | 🎙️ |
| 13 | Phone data quality: E.164, re-enrich, provenance | Later | S–M | Numbers are stored in whatever format the provider returns | 🎙️ |
| 14 | Scale and operations: pagination, observability, load tests, auth | Later | L | Needed before real customer volume | 🎙️ |

---

## Now

### 1. Make `main` verifiable 🎙️

**Problem**
- **`pnpm lint` crashes.** ESLint 9.34 is installed, but the config is the legacy `frontend/.eslintrc.cjs`.
- **Hidden lint errors.** With `ESLINT_USE_FLAT_CONFIG=false` it runs and reports **24 `no-explicit-any` errors** (in `api/utils.ts`, `useApiMutation.ts`, `bulkImport.ts` and `globalTypes.d.ts`).
- **The frontend type check fails.** `tsc -p tsconfig.app.json` fails at `useApiMutation.ts:64` (missing `emailVerified`). #6 fixes it.
- **No safety net.** There's no CI and no commit-message linting. 🎙️
- **No PR standard.** #1 arrived with an empty description, and the title was just the branch name. 🎙️

**Impact**
- Reviewers can't trust a green PR, because nothing checks it.
- Type errors and lint debt pile up silently.

**Proposal**
1. Migrate to `eslint.config.js`. Fix the 24 errors, or suppress them explicitly with a ticket.
2. Add a GitHub Actions workflow that runs `lint`, `tsc` and `vitest` for `backend/` and `frontend/` on every PR. 🎙️
3. Add `commitlint` with `config-conventional` and a `commit-msg` hook. Today Conventional Commits are only a convention.
4. Add a `pre-commit` hook (lint-staged) that runs lint and the affected tests before a commit, not only in CI. 🎙️
5. Add `.github/pull_request_template.md` with a checklist: what and why, ticket, test plan, screenshots, migrations, env changes. 🎙️

**Effort:** S

**Evidence**
- `pnpm lint` output.
- `frontend/.eslintrc.cjs` exists.
- There's no `.github/` directory.
- #1 has an empty description.

### 2. One pattern for third-party calls 🎙️

**Problem**
- **Email verification** awaited the workflow inside the HTTP request. The activity had a 1 s timeout and Temporal's default unlimited retries, so a slow check hung the request forever. Fixed in #5, but the endpoint is still synchronous and takes up to about 9 s.
- **PR #1 (gender guessing)** calls genderize once per lead, one after another, inside the request, with no timeout.
- **The frontend HTTP client has no timeout** (`frontend/src/utils/axios.ts`), so the browser waits as long as the server does.
- **No progress feedback.** Verify Email has no loading state while it runs, and nothing limits how many leads one request may carry. 🎙️

**Impact**
- Requests can hang, and one slow lead blocks a whole batch.
- External rate limits surface to the user as random failures.

**Proposal:** use the pattern from #6 (enrich phone) for every external call:
- `POST` starts a Temporal workflow with a deterministic ID per lead and returns **202**.
- One standard status contract (`PENDING` / done / `FAILED`) that every enrichment endpoint and the UI share, instead of a bespoke response per endpoint. 🎙️
- A status column, which the UI polls.
- Bounded retries, and per-call timeouts.

Apply it to email verification next, including a pending state on the action and a cap on IDs per request. 🎙️ Add a default axios timeout of about 30 s as a backstop.

**Effort:** M

**Evidence**
- `backend/src/workflows/workflows.ts:4-6` on `main`.
- `index.ts:276-307` on `main`.
- PR #1 review: 22 of 25 leads failed with `429` against the live API.

### 3. Validate input at the API boundary 🎙️

**Problem**
- **Validation lives in the frontend.** `/leads/bulk` only checks that `firstName`, `lastName` and `email` are present. Everything else is only validated by the CSV parser. #4 adds a server-side country check, but there's no general schema.
- **API calls bypass it.** Anyone can POST to the API directly and skip the UI's checks. 🎙️ PR #1 would have stored any `gender` string.
- **A latent `PUT`/`PATCH` mismatch.** The frontend `update` sends `PUT` (`frontend/src/api/modules/leads.ts:18`), but the backend only defines `PATCH /leads/:id` (`index.ts:57`). Nothing calls `update` yet. 🎙️

**Impact:** any client other than our UI can write invalid data.

**Proposal**
- One request schema per endpoint, shared by the frontend and the backend. 🎙️ This is a good fit for the shared package in item 9.
- Decide between a small hand-written validator and a library such as zod.
- Align the `update` method.

**Effort:** M

**Evidence**
- `index.ts:182-194` on `main`.
- PR #1 review: storing `"banana"` was reproduced.

### 4. Small production-hygiene fixes 🎙️

| Fix | Where | Effort |
|---|---|---|
| Restrict CORS to the frontend origin, from env (it's `*` today). Per-environment values are in item 8. 🎙️ | `index.ts:10-14` | S |
| Exclude `*.test.ts` from the backend build (tests are compiled into `dist/`) | `backend/tsconfig.json` | S |
| Fill in `.env.sample` (it lists an unused MySQL `DATABASE_URL`; #6 adds the provider key names) | `backend/.env.sample` | S |

### 5. Backfill and normalise existing country data 🎙️

**Problem**
- **#4 only validates new imports.** Rows imported before it keep whatever they had: invalid codes such as `XXX` or `12`, and lower-case values.
- **`UK` isn't an ISO code.** The ISO code is `GB`. `UK` is accepted on input today, because it's common in our data, so the database holds two codes for one country. 🎙️

**Impact**
- Filters and reports split one country into two.
- Integrations that expect ISO codes receive `UK`, or worse, `XXX`.

**Proposal**
- A one-off migration script (dry-run first):
  - upper-case every code
  - map `UK` → `GB`
  - set unknown codes to `null`
  - report how many rows changed
- Then normalise `UK` → `GB` on input as well, so new rows don't need fixing.

**Effort:** S

**Evidence:** the seed data contains `UK` (`sqlite3 dev.db`). `toCountryCode` in #4 accepts `UK` unchanged.

---

## Next

### 6. Provider resilience

**Problem**
- **Rate limits.** The phone providers announced rate limits, and #6 has none. 429 is retried, but nothing paces requests.
- **No cancellation.** A timed-out activity keeps its `fetch` running in the background.
- **A stuck state.** If the final database write fails all its retries, a lead stays `PENDING`.

**Impact**
- When limits land, bursts will fail and retry storms will make it worse.
- Users can see a lead searching forever.

**Proposal**
- One task queue per provider, with the worker option `maxTaskQueueActivitiesPerSecond`. The Temporal server enforces it across workers.
- Honour `Retry-After` when providers send it.
- Use `@temporalio/activity` for heartbeats and `cancellationSignal` → `fetch`.
- A periodic sweep that marks `PENDING` older than N minutes as `FAILED`.

**Effort:** M

**Evidence:** #6, "Still to do" and the `ponytail:` comments in `phoneProviders.ts`.

### 7. Provider contract tests

**Problem**
- **The README is wrong for Nimbus.** It documents `{ "number": number }`, but the live API returns `{ "phoneNmbr": number, "countryCode": "ES" }`. I checked with curl on 2026-11-06.
- **Undocumented failure modes.** Orion and Nimbus return random 500s, and Orion returns 400 without `companyWebsite`. The README mentions none of this.

**Impact:** a silent provider change ends up as `NOT_FOUND`, not as an error.

**Proposal**
- A scheduled contract check: a nightly CI job that sends one known request per provider and checks the response shape.
- Alerts when the shape drifts.

**Effort:** S

### 8. Environments and secrets management 🎙️

**Problem**
- **No production configuration.** The Temporal address (`localhost:7233`), the namespace and the CORS policy are hard-coded.
- **Keys only live on each developer's machine.** Provider keys live in a local `backend/.env`. There's no notion of sandbox and production environments, and nowhere for CI or deployments to get secrets from. 🎙️

**Impact**
- **No staging.** We can't run a staging environment against sandbox provider keys.
- **Keys handled by hand.** Rotating a key means editing files by hand.

**Proposal**
- Read all config from env, validated once at startup: fail fast with a list of missing values (#6 already warns for the provider keys).
- One config set per environment (local, sandbox, production). 🎙️
- Secrets in GitHub Secrets for CI, and in a secrets manager for deployed environments. 🎙️
- CORS allowlist per environment: local origins in development, a restricted allowlist in sandbox (e.g. office IPs), and only the app's origin in production. 🎙️

**Effort:** M

### 9. One source of truth for lead fields and reference data 🎙️

**Problem**
- **The message fields are defined twice:** `backend/src/utils/messageGenerator.ts:13` and `frontend/src/components/MessageTemplateModal.tsx:109`.
- **The country list is duplicated** in frontend and backend (#4). 🎙️
- **More fields are coming.** The new-fields task alone adds phone, years in role and LinkedIn.

**Impact:** every new field means editing 5 or more places, and the two lists drift apart.

**Proposal**
- A `shared/` workspace package with the field definitions (key, label, type, validation) and the reference data. 🎙️
- Or a `GET /meta/lead-fields` endpoint, if a shared package is too heavy.
- The template field picker is built from that list, with search, so it scales past a handful of fields.

**Effort:** M

### 10. Correct and fast bulk import

**Problem**
- **Duplicate detection matches on first and last name only** (`index.ts:202-217`), so two different people with the same name collide.
- **Two imports at the same time can race.**
- **Rows are created one at a time** (`index.ts:222`).

**Impact**
- Leads are wrongly skipped.
- Large CSVs are slow.

**Proposal**
- A unique index on a real identity, e.g. `email`. That's a product decision.
- `createMany` or `upsert` in a transaction.
- Return per-row results.

**Effort:** M

### 11. Split `index.ts` 🎙️

**Problem:** every endpoint, the Temporal client and the server bootstrap live in one 323-line file. 🎙️

**Proposal:** one router per resource (`routes/leads.ts`, …). Keep the shared `db.ts` (introduced in #6), and add a `temporal.ts` for the client. #5 already exports `app` for tests.

**Effort:** M, mostly mechanical. Best done after the open PRs merge, to avoid conflicts.

### 12. Developer experience 🎙️

| Problem | Proposal | Effort |
|---|---|---|
| `backend/prisma/dev.db` is tracked, so every local run or migration shows up as a change 🎙️ | `prisma db seed` with the 25 sample leads; untrack `dev.db` | S |
| No React Testing Library: component tests render with `react-dom` and `act()` by hand (#5) | Add `@testing-library/react` and `user-event` | S |
| Component tests assert exact toast sentences, so any copy change breaks them 🎙️ | Match partial text, or move user-facing strings to message IDs (which also prepares for i18n) | S |
| No `@temporalio/testing`: the workflows are unit-tested with mocks, and retry and timeout behaviour is only checked live | Add `TestWorkflowEnvironment` tests for the retry policies | S |
| The Node version is only in `.nvmrc`. Shells that don't load nvm, such as CI, scripts and AI tools, use whatever is installed (v24 here) | Add `engines.node` to both `package.json` files | S |

---

## Later

### 13. Phone data quality 🎙️

**Problem**
- **Inconsistent formats.** Numbers are stored exactly as each provider returns them, and the sample CSVs mix formats such as `+1-280-754-0462x2154` and `(731)123-9702`.
- **No re-enrich.** `NOT_FOUND` is final by design ("only one per lead"), so a lead can never be looked up again, even after providers gain data.
- **No provenance.** The lead doesn't record which provider found the number (or whether it came from a CSV), so users can't judge its quality, and we can't measure hit rate per provider. 🎙️

**Proposal**
- Normalise to E.164, using Nimbus's `countryCode` or the lead's country.
- An explicit "Re-enrich" action, with a new workflow ID scheme, e.g. `enrich-phone-<id>-<n>`.
- Store `phoneSource` (provider or `csv`) and show it in the Phone column. 🎙️

**Effort:** S–M

### 14. Scale and operations 🎙️

| Area | Today | Proposal | Effort |
|---|---|---|---|
| Leads table | `GET /leads` returns every row (`index.ts:52`), and the table renders all of them | Server-side pagination and filters; virtualised rows | M |
| Observability | `console.error` only | Structured logs shipped to a log service. 🎙️ Temporal search attributes (`leadId`, provider). Hit rate and latency per provider. | M |
| Load testing 🎙️ | No idea how bulk import, verification or enrichment behave at volume | A load-test script (e.g. k6) for `/leads/bulk` and the enrichment endpoints at the expected volume, run before releases | M |
| Auth and tenancy | No authentication; one global lead list | Auth, plus a workspace scope on every query | L |

---

## Open product questions

1. **Invalid optional fields in a CSV:** should an invalid country block the row (today, after #4), or import the lead with the field empty and show a warning?
2. **Gender inference (#1):** 🎙️ what is it for, how is the guess shown to users, and how do they override it? A gender inferred from a first name is personal data under GDPR and is often wrong.
3. **`NOT_FOUND` leads:** should they become eligible again after some time, e.g. 90 days?
4. **Provider order:** it's quality-first today (Orion → Astra → Nimbus). Once we know each provider's cost and hit rate, should the order optimise for cost?

## Suggested sequence

1. **Sprint 1:** item 1 (CI, lint, hooks, PR template), item 4 (hygiene), item 5 (country backfill), then merge #4, #5 and #6.
2. **Sprint 2:** item 2 (email verification to start-and-poll), item 6 (rate limits before the providers enforce them), item 7, item 8 (environments).
3. **Sprint 3:** item 9 (shared fields; this unblocks the new-lead-fields work), items 3, 10 and 11.
4. **Later:** items 12–14, as volume and team size require.
