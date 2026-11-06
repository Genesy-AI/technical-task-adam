import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

const { prismaLead, connect, execute, start } = vi.hoisted(() => ({
  prismaLead: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  connect: vi.fn(async () => ({})),
  execute: vi.fn(),
  start: vi.fn(),
}))

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    lead = prismaLead
  },
}))
vi.mock('@temporalio/client', () => ({
  Connection: { connect },
  Client: class {
    workflow = { execute, start }
  },
}))
vi.mock('./worker', () => ({ runTemporalWorker: vi.fn() }))

import { app } from './index'

const john = { id: 1, firstName: 'John', lastName: 'Doe', email: 'john.doe@example.com' }
const jane = { id: 2, firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@example.com' }

let server: Server
let baseUrl: string
beforeAll(() => {
  server = app.listen(0)
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
// `connect` is deliberately not reset: it counts connections across the whole file
beforeEach(() =>
  [prismaLead.findMany, prismaLead.update, prismaLead.updateMany, execute, start].forEach((mock) =>
    mock.mockReset()
  )
)

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const verify = (body: unknown) => post('/leads/verify-emails', body)

describe('POST /leads/verify-emails', () => {
  it('rejects a missing or empty leadIds array', async () => {
    expect((await verify({})).status).toBe(400)
    expect((await verify({ leadIds: [] })).status).toBe(400)
  })

  it('reports failed workflows as errors without marking the email invalid', async () => {
    prismaLead.findMany.mockResolvedValue([john, jane])
    execute.mockImplementation(async (_wf, { args: [email] }) => {
      if (email === jane.email) throw new Error('Workflow execution failed')
      return false
    })

    const res = await verify({ leadIds: [1, 2] })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      verifiedCount: 1,
      results: [{ leadId: 1, emailVerified: false }],
      errors: [{ leadId: 2, leadName: 'Jane Smith', error: 'Workflow execution failed' }],
    })
    // Jane's emailVerified is never written, so it stays null (unknown) rather than false (invalid)
    expect(prismaLead.update).toHaveBeenCalledTimes(1)
    expect(prismaLead.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { emailVerified: false } })
  })

  it('starts one idempotent workflow per lead', async () => {
    prismaLead.findMany.mockResolvedValue([john])
    execute.mockResolvedValue(true)

    await verify({ leadIds: [1] })

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workflowId: 'verify-email-1', workflowIdConflictPolicy: 'USE_EXISTING' })
    )
  })

  it('verifies leads in parallel, so one slow lead does not delay the others', async () => {
    prismaLead.findMany.mockResolvedValue([john, jane])
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    execute.mockImplementation(async () => {
      if (++started === 2) release() // only resolves if both workflows were started before either finished
      await gate
      return true
    })

    const res = await verify({ leadIds: [1, 2] })

    expect((await res.json()).verifiedCount).toBe(2)
  })

  it('reuses one Temporal connection across requests', async () => {
    prismaLead.findMany.mockResolvedValue([john])
    execute.mockResolvedValue(true)

    await verify({ leadIds: [1] })
    await verify({ leadIds: [1] })

    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe('POST /leads/enrich-phones', () => {
  it('only starts leads that were never enriched or failed, marking them PENDING first', async () => {
    prismaLead.findMany.mockResolvedValue([john])
    start.mockResolvedValue({})

    const res = await post('/leads/enrich-phones', { leadIds: [1, 2] })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ started: 1, skipped: 1, failedToStart: 0 })
    expect(prismaLead.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [1, 2] },
        phoneNumber: null,
        OR: [{ phoneEnrichmentStatus: null }, { phoneEnrichmentStatus: 'FAILED' }],
      },
    })
    expect(prismaLead.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
      data: { phoneEnrichmentStatus: 'PENDING' },
    })
    expect(prismaLead.updateMany.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0])
  })

  it('starts one idempotent workflow per lead without waiting for it', async () => {
    prismaLead.findMany.mockResolvedValue([john])
    start.mockResolvedValue({})

    await post('/leads/enrich-phones', { leadIds: [1] })

    expect(execute).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workflowId: 'enrich-phone-1',
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
        args: [1, expect.objectContaining({ email: john.email, companyWebsite: 'example.com' })],
      })
    )
  })

  it('marks a lead FAILED when Temporal refuses to start its workflow', async () => {
    prismaLead.findMany.mockResolvedValue([john])
    start.mockRejectedValue(new Error('Workflow execution already started'))

    const res = await post('/leads/enrich-phones', { leadIds: [1] })

    expect(await res.json()).toEqual({ started: 0, skipped: 0, failedToStart: 1 })
    expect(prismaLead.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: [1] }, phoneEnrichmentStatus: 'PENDING' },
      data: { phoneEnrichmentStatus: 'FAILED' },
    })
  })
})
