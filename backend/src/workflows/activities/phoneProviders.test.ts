import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../db', () => ({ prisma: {} }))

import { lookupPhone, providers, ProviderRejectedError, toPhoneLookupInput } from './phoneProviders'

const lead = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  jobTitle: 'CTO',
  companyWebsite: 'example.com',
}

const mockFetch = (status: number, body: unknown = {}) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))

afterEach(() => vi.restoreAllMocks())

describe('provider adapters', () => {
  it('builds each provider request with its own input and auth', () => {
    expect(providers.orion.request(lead)).toMatchObject({
      path: 'orionConnect',
      headers: { 'x-auth-me': expect.any(String) },
      body: { fullName: 'Ada Lovelace', companyWebsite: 'example.com' },
    })
    expect(providers.astra.request(lead)).toMatchObject({
      path: 'astraDialer',
      headers: { apiKey: expect.any(String) },
      body: { email: 'ada@example.com' },
    })
    expect(providers.nimbus.request(lead)).toMatchObject({
      path: 'numbusLookup',
      query: { api: expect.any(String) },
      body: { email: 'ada@example.com', jobTitle: 'CTO' },
    })
  })

  it('skips a provider when the lead lacks its required input', () => {
    expect(providers.orion.request({ ...lead, companyWebsite: null })).toBeNull()
    expect(providers.nimbus.request({ ...lead, jobTitle: null })).toBeNull()
  })

  it('parses each response shape seen on the live APIs', () => {
    expect(providers.orion.parse({ phone: '4876025880' })).toBe('4876025880')
    expect(providers.orion.parse({ phone: null })).toBeNull()
    expect(providers.astra.parse({ phoneNmbr: '+1 555 0100' })).toBe('+1 555 0100')
    expect(providers.astra.parse({ phoneNmbr: null })).toBeNull()
    expect(providers.astra.parse({})).toBeNull() // live API omits the field when it has no data
    expect(providers.nimbus.parse({ phoneNmbr: 2808787861, countryCode: 'ES' })).toBe('2808787861') // live
    expect(providers.nimbus.parse({ number: 2808787861, countryCode: 'ES' })).toBe('2808787861') // README
  })
})

describe('toPhoneLookupInput', () => {
  it('uses the email domain as company website, except for free mail', () => {
    const base = { firstName: 'Ada', lastName: 'Lovelace', jobTitle: null }
    expect(toPhoneLookupInput({ ...base, email: 'ada@Enginy.ai' }).companyWebsite).toBe('enginy.ai')
    expect(toPhoneLookupInput({ ...base, email: 'ada@gmail.com' }).companyWebsite).toBeNull()
    expect(toPhoneLookupInput({ ...base, email: 'ada@gmail.com' }).fullName).toBe('Ada Lovelace')
  })
})

describe('lookupPhone', () => {
  it('returns the parsed phone', async () => {
    mockFetch(200, { phone: '4876025880' })
    await expect(lookupPhone('orion', lead)).resolves.toBe('4876025880')
  })

  it('does not call a provider whose input is missing', async () => {
    const fetchSpy = mockFetch(200)
    await expect(lookupPhone('nimbus', { ...lead, jobTitle: null })).resolves.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws a non-retryable error on 4xx and a retryable one on 429 and 5xx', async () => {
    mockFetch(401)
    await expect(lookupPhone('astra', lead)).rejects.toBeInstanceOf(ProviderRejectedError)
    for (const status of [429, 500]) {
      mockFetch(status)
      const error = await lookupPhone('astra', lead).catch((e) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(ProviderRejectedError)
    }
  })
})
