import { ActivityOptions, ApplicationFailure, proxyActivities, RetryPolicy } from '@temporalio/workflow'
import type * as activities from './activities'
import type { PhoneLookupInput } from './activities/phoneProviders'

// Temporal retries activities forever by default, so a slow provider would hang the request.
// Worst case: 3 × 2 s attempts + 1 s + 2 s backoff ≈ 9 s, then the workflow fails.
const { verifyEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', backoffCoefficient: 2 },
})

export async function verifyEmailWorkflow(email: string): Promise<boolean> {
  return await verifyEmail(email)
}

const retry: RetryPolicy = {
  maximumAttempts: 3,
  initialInterval: '1 second',
  backoffCoefficient: 2,
  nonRetryableErrorTypes: ['ProviderRejectedError'], // 4xx: fail at once instead of 3×
}

// Order is the product requirement. Timeouts are ~2× each provider's measured latency.
const lookupWithTimeout = (startToCloseTimeout: ActivityOptions['startToCloseTimeout']) =>
  proxyActivities<typeof activities>({ startToCloseTimeout, retry }).lookupPhone
const PHONE_PROVIDERS = [
  { name: 'orion', lookupPhone: lookupWithTimeout('8 seconds') }, // ~4.2 s, best data, random 500s
  { name: 'astra', lookupPhone: lookupWithTimeout('5 seconds') }, // ~1.2 s, weakest data
  { name: 'nimbus', lookupPhone: lookupWithTimeout('5 seconds') }, // ~2.2 s, random 500s
] as const

const { finishPhoneEnrichment } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 seconds',
  retry,
})

export async function enrichPhoneWorkflow(leadId: number, lead: PhoneLookupInput): Promise<string | null> {
  let providerFailed = false
  for (const { name, lookupPhone } of PHONE_PROVIDERS) {
    try {
      const phone = await lookupPhone(name, lead)
      if (phone) {
        await finishPhoneEnrichment(leadId, { status: 'FOUND', phone })
        return phone // stop early
      }
    } catch {
      providerFailed = true // this provider used up its retries: try the next one
    }
  }

  // "No data found" is final, so only claim it when every provider actually answered.
  if (!providerFailed) {
    await finishPhoneEnrichment(leadId, { status: 'NOT_FOUND' })
    return null
  }
  await finishPhoneEnrichment(leadId, { status: 'FAILED' })
  // A plain Error would fail the workflow *task* and retry forever; ApplicationFailure fails the run,
  // which ALLOW_DUPLICATE_FAILED_ONLY then allows to be started again.
  throw ApplicationFailure.create({
    message: 'A phone provider failed and no phone was found; retry later',
    nonRetryable: true,
  })
}
