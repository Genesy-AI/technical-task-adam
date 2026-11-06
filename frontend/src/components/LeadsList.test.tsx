import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { api } from '../api'
import { LeadsList } from './LeadsList'
import type { LeadsVerifyEmailsOutput } from '../api/types/leads/verifyEmails'

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../api', () => ({ api: { leads: { getMany: vi.fn(), verifyEmails: vi.fn() } } }))

// No @testing-library/react in the repo, so render with react-dom and React's act().
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const lead = (id: number, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.com`,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  jobTitle: null,
  countryCode: null,
  companyName: null,
  message: null,
  emailVerified: null,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.leads.getMany).mockResolvedValue([lead(1, 'John', 'Doe'), lead(2, 'Jane', 'Smith')])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const clickButton = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  if (!button) throw new Error(`No button with text "${text}"`)
  await act(async () => button.click())
}

const verifyAllLeads = async (response: LeadsVerifyEmailsOutput) => {
  vi.mocked(api.leads.verifyEmails).mockResolvedValue(response)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <LeadsList />
      </QueryClientProvider>
    )
  )
  await act(() => new Promise((resolve) => setTimeout(resolve))) // let the leads query resolve
  const selectAll = container.querySelector<HTMLInputElement>('thead input[type="checkbox"]')!
  await act(async () => selectAll.click())
  await clickButton('Enrich')
  await clickButton('Verify Email')
  expect(api.leads.verifyEmails).toHaveBeenCalledWith({ leadIds: [1, 2] })
}

const janeFailed = { leadId: 2, leadName: 'Jane Smith', error: 'Workflow execution failed' }

describe('LeadsList email verification feedback', () => {
  it('shows a success toast and names the leads that could not be verified', async () => {
    await verifyAllLeads({
      success: true,
      verifiedCount: 1,
      results: [{ leadId: 1, emailVerified: false }],
      errors: [janeFailed],
    })

    expect(toast.success).toHaveBeenCalledWith('Verified 1 email')
    expect(toast.error).toHaveBeenCalledWith('Could not verify: Jane Smith')
  })

  it('does not show a success toast when every verification failed', async () => {
    await verifyAllLeads({
      success: true,
      verifiedCount: 0,
      results: [],
      errors: [{ leadId: 1, leadName: 'John Doe', error: 'Workflow execution failed' }, janeFailed],
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not verify: John Doe, Jane Smith')
  })

  it('shows only a success toast when every lead was verified', async () => {
    await verifyAllLeads({
      success: true,
      verifiedCount: 2,
      results: [
        { leadId: 1, emailVerified: true },
        { leadId: 2, emailVerified: true },
      ],
      errors: [],
    })

    expect(toast.success).toHaveBeenCalledWith('Verified 2 emails')
    expect(toast.error).not.toHaveBeenCalled()
  })
})
