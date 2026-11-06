import { proxyActivities } from '@temporalio/workflow'
import type * as activities from './activities'

// Temporal retries activities forever by default, so a slow provider would hang the request.
// Worst case: 3 × 2 s attempts + 1 s + 2 s backoff ≈ 9 s, then the workflow fails.
const { verifyEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', backoffCoefficient: 2 },
})

export async function verifyEmailWorkflow(email: string): Promise<boolean> {
  return await verifyEmail(email)
}
