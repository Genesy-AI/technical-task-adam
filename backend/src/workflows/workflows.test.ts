import { describe, it, expect, vi, beforeEach } from 'vitest'

// No @temporalio/testing in the repo: run the workflow function with proxyActivities mocked,
// which is enough to check the waterfall logic. Retries and timeouts are Temporal's job.
const { lookups, finishPhoneEnrichment } = vi.hoisted(() => ({
  lookups: {} as Record<string, () => Promise<string | null>>,
  finishPhoneEnrichment: vi.fn(),
}))

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    verifyEmail: vi.fn(),
    finishPhoneEnrichment,
    lookupPhone: (name: string) => lookups[name](),
  }),
  ApplicationFailure: { create: ({ message }: { message: string }) => new Error(message) },
}))

import { enrichPhoneWorkflow } from './workflows'

const lead = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  jobTitle: 'CTO',
  companyWebsite: 'example.com',
}
const called: string[] = []
const provider = (name: string, result: string | null | Error) => {
  lookups[name] = async () => {
    called.push(name)
    if (result instanceof Error) throw result
    return result
  }
}

beforeEach(() => {
  called.length = 0
  finishPhoneEnrichment.mockReset()
})

describe('enrichPhoneWorkflow', () => {
  it('stops at the first provider that finds a phone', async () => {
    provider('orion', null)
    provider('astra', '+34 600 000 000')
    provider('nimbus', '999')

    await expect(enrichPhoneWorkflow(1, lead)).resolves.toBe('+34 600 000 000')
    expect(called).toEqual(['orion', 'astra'])
    expect(finishPhoneEnrichment).toHaveBeenCalledWith(1, { status: 'FOUND', phone: '+34 600 000 000' })
  })

  it('falls through a failing provider to the next one', async () => {
    provider('orion', new Error('orion responded 500'))
    provider('astra', null)
    provider('nimbus', '2808787861')

    await expect(enrichPhoneWorkflow(1, lead)).resolves.toBe('2808787861')
    expect(called).toEqual(['orion', 'astra', 'nimbus'])
  })

  it('marks NOT_FOUND only when every provider answered without a phone', async () => {
    provider('orion', null)
    provider('astra', null)
    provider('nimbus', null)

    await expect(enrichPhoneWorkflow(1, lead)).resolves.toBeNull()
    expect(finishPhoneEnrichment).toHaveBeenCalledWith(1, { status: 'NOT_FOUND' })
  })

  it('marks FAILED and fails the run when a provider errored and none found a phone', async () => {
    provider('orion', new Error('orion responded 500'))
    provider('astra', null)
    provider('nimbus', null)

    await expect(enrichPhoneWorkflow(1, lead)).rejects.toThrow('A phone provider failed')
    expect(finishPhoneEnrichment).toHaveBeenCalledWith(1, { status: 'FAILED' })
    expect(finishPhoneEnrichment).not.toHaveBeenCalledWith(1, { status: 'NOT_FOUND' })
  })
})
