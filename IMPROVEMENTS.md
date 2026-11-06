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

## Summary

| # | Item | Horizon | Effort | Why now |
|---|---|---|---|---|
| 1 | Make `main` verifiable: lint, type check, CI, commit linting | Now | S | Two broken checks already reached `main` unnoticed |
| 2 | One pattern for third-party calls (Temporal + start-and-poll) | Now | M | The email-verification hang and PR #1 have the same root cause |
| 3 | Validate input at the API boundary | Now | M | The frontend parser is the only validation for most fields |
| 4 | Small production-hygiene fixes | Now | S | Cheap, and they remove real risks |
| 5 | Provider resilience: rate limits, cancellation, stuck runs | Next | M | Providers have announced rate limits |
| 6 | Provider contract tests | Next | S | The README's Nimbus contract is already wrong |
| 7 | One source of truth for lead fields and reference data | Next | M | Fields are about to grow, and lists are already duplicated |
| 8 | Correct and fast bulk import | Next | M | Duplicate detection is name-only and imports one row at a time |
| 9 | Split `index.ts` into routers | Next | M | 323 lines today, and every feature adds to it |
| 10 | Developer experience: seed data, test tooling, Node version | Next | S | Recurring friction during this work |
| 11 | Phone data quality: E.164 and re-enrich | Later | S–M | Numbers are stored in whatever format the provider returns |
| 12 | Scale and operations: pagination, observability, auth | Later | L | Needed before real customer volume |

---

## Now

### 1. Make `main` verifiable

**Problem**
- **`pnpm lint` crashes.** ESLint 9.34 is installed, but the config is the legacy `frontend/.eslintrc.cjs`.
- **Hidden lint errors.** With `ESLINT_USE_FLAT_CONFIG=false` it runs and reports **24 `no-explicit-any` errors** (in `api/utils.ts`, `useApiMutation.ts`, `bulkImport.ts` and `globalTypes.d.ts`).
- **The frontend type check fails.** `tsc -p tsconfig.app.json` fails at `useApiMutation.ts:64` (missing `emailVerified`). #6 fixes it.
- **No safety net.** There's no CI and no commit-message linting.

**Impact**
- Reviewers can't trust a green PR, because nothing checks it.
- Type errors and lint debt pile up silently.

**Proposal**
1. Migrate to `eslint.config.js`. Fix the 24 errors, or suppress them explicitly with a ticket.
2. Add a GitHub Actions workflow that runs `lint`, `tsc` and `vitest` for `backend/` and `frontend/` on every PR.
3. Add `commitlint` with `config-conventional` and a `commit-msg` hook. Today Conventional Commits are only a convention.

**Effort:** S

**Evidence**
- `pnpm lint` output.
- `frontend/.eslintrc.cjs` exists.
- There's no `.github/` directory.

### 2. One pattern for third-party calls

**Problem**
- **Email verification** awaited the workflow inside the HTTP request. The activity had a 1 s timeout and Temporal's default unlimited retries, so a slow check hung the request forever. Fixed in #5, but the endpoint is still synchronous and takes up to about 9 s.
- **PR #1 (gender guessing)** calls genderize once per lead, one after another, inside the request, with no timeout.
- **The frontend HTTP client has no timeout** (`frontend/src/utils/axios.ts`), so the browser waits as long as the server does.

**Impact**
- Requests can hang, and one slow lead blocks a whole batch.
- External rate limits surface to the user as random failures.

**Proposal:** use the pattern from #6 (enrich phone) for every external call:
- `POST` starts a Temporal workflow with a deterministic ID per lead and returns **202**.
- A status column, which the UI polls.
- Bounded retries, and per-call timeouts.

Apply it to email verification next. Add a default axios timeout of about 30 s as a backstop.

**Effort:** M

**Evidence**
- `backend/src/workflows/workflows.ts:4-6` on `main`.
- `index.ts:276-307` on `main`.
- PR #1 review: 22 of 25 leads failed with `429` against the live API.

### 3. Validate input at the API boundary

**Problem**
- **Validation lives in the frontend.** `/leads/bulk` only checks that `firstName`, `lastName` and `email` are present. Everything else is only validated by the CSV parser. #4 adds a server-side country check, but there's no general schema.
- **API calls bypass it.** PR #1 would have stored any `gender` string sent directly to the API.
- **A latent `PUT`/`PATCH` mismatch.** The frontend `update` sends `PUT` (`frontend/src/api/modules/leads.ts:18`), but the backend only defines `PATCH /leads/:id` (`index.ts:57`). Nothing calls `update` yet.

**Impact:** any client other than our UI can write invalid data.

**Proposal**
- One request schema per endpoint, shared by the frontend and the backend. This is a good fit for the shared package in item 7.
- Decide between a small hand-written validator and a library such as zod.
- Align the `update` method.

**Effort:** M

**Evidence**
- `index.ts:182-194` on `main`.
- PR #1 review: storing `"banana"` was reproduced.

### 4. Small production-hygiene fixes

| Fix | Where | Effort |
|---|---|---|
| Restrict CORS to the frontend origin, from env (it's `*` today) | `index.ts:10-14` | S |
| Exclude `*.test.ts` from the backend build (tests are compiled into `dist/`) | `backend/tsconfig.json` | S |
| Fill in `.env.sample` (it lists an unused MySQL `DATABASE_URL`; #6 adds the provider key names) | `backend/.env.sample` | S |

---

## Next

### 5. Provider resilience

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

### 6. Provider contract tests

**Problem**
- **The README is wrong for Nimbus.** It documents `{ "number": number }`, but the live API returns `{ "phoneNmbr": number, "countryCode": "ES" }`. I checked with curl on 2026-11-06.
- **Undocumented failure modes.** Orion and Nimbus return random 500s, and Orion returns 400 without `companyWebsite`. The README mentions none of this.

**Impact:** a silent provider change ends up as `NOT_FOUND`, not as an error.

**Proposal**
- A scheduled contract check: a nightly CI job that sends one known request per provider and checks the response shape.
- Alerts when the shape drifts.

**Effort:** S

### 7. One source of truth for lead fields and reference data

**Problem**
- **The message fields are defined twice:** `backend/src/utils/messageGenerator.ts:13` and `frontend/src/components/MessageTemplateModal.tsx:109`.
- **The country list is duplicated** in frontend and backend (#4).
- **More fields are coming.** The new-fields task alone adds phone, years in role and LinkedIn.

**Impact:** every new field means editing 5 or more places, and the two lists drift apart.

**Proposal**
- A `shared/` workspace package with the field definitions (key, label, type, validation) and the reference data.
- Or a `GET /meta/lead-fields` endpoint, if a shared package is too heavy.
- The template field picker is built from that list, with search, so it scales past a handful of fields.

**Effort:** M

### 8. Correct and fast bulk import

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

### 9. Split `index.ts`

**Problem:** every endpoint, the Temporal client and the server bootstrap live in one 323-line file.

**Proposal:** one router per resource (`routes/leads.ts`, …). Keep the shared `db.ts` (introduced in #6), and add a `temporal.ts` for the client. #5 already exports `app` for tests.

**Effort:** M, mostly mechanical. Best done after the open PRs merge, to avoid conflicts.

### 10. Developer experience

| Problem | Proposal | Effort |
|---|---|---|
| `backend/prisma/dev.db` is tracked, so every local run or migration shows up as a change | `prisma db seed` with the 25 sample leads; untrack `dev.db` | S |
| No React Testing Library: component tests render with `react-dom` and `act()` by hand (#5) | Add `@testing-library/react` and `user-event` | S |
| No `@temporalio/testing`: the workflows are unit-tested with mocks, and retry and timeout behaviour is only checked live | Add `TestWorkflowEnvironment` tests for the retry policies | S |
| The Node version is only in `.nvmrc`. Shells that don't load nvm, such as CI, scripts and AI tools, use whatever is installed (v24 here) | Add `engines.node` to both `package.json` files | S |

---

## Later

### 11. Phone data quality

**Problem**
- **Inconsistent formats.** Numbers are stored exactly as each provider returns them, and the sample CSVs mix formats such as `+1-280-754-0462x2154` and `(731)123-9702`.
- **No re-enrich.** `NOT_FOUND` is final by design ("only one per lead"), so a lead can never be looked up again, even after providers gain data.

**Proposal**
- Normalise to E.164, using Nimbus's `countryCode` or the lead's country.
- An explicit "Re-enrich" action, with a new workflow ID scheme, e.g. `enrich-phone-<id>-<n>`.

**Effort:** S–M

### 12. Scale and operations

| Area | Today | Proposal | Effort |
|---|---|---|---|
| Leads table | `GET /leads` returns every row (`index.ts:52`), and the table renders all of them | Server-side pagination and filters; virtualised rows | M |
| Observability | `console.error` only | Structured logs; Temporal search attributes (`leadId`, provider); hit rate and latency per provider | M |
| Auth and tenancy | No authentication; one global lead list | Auth, plus a workspace scope on every query | L |

---

## Open product questions

1. **Invalid optional fields in a CSV:** should an invalid country block the row (today, after #4), or import the lead with the field empty and show a warning?
2. **Gender inference (#1):** what is it for, how is the guess shown to users, and how do they override it? A gender inferred from a first name is personal data and is often wrong.
3. **`NOT_FOUND` leads:** should they become eligible again after some time, e.g. 90 days?
4. **Provider order:** it's quality-first today (Orion → Astra → Nimbus). Once we know each provider's cost and hit rate, should the order optimise for cost?

## Suggested sequence

1. **Sprint 1:** item 1 (CI and lint), item 4 (hygiene), then merge #4, #5 and #6.
2. **Sprint 2:** item 2 (email verification to start-and-poll), item 5 (rate limits before the providers enforce them), item 6.
3. **Sprint 3:** item 7 (shared fields; this unblocks the new-lead-fields work), items 3, 8 and 9.
4. **Later:** items 10–12, as volume and team size require.
