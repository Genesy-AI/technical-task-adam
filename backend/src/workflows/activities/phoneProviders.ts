import { prisma } from '../../db'

export type PhoneEnrichmentStatus = 'PENDING' | 'FOUND' | 'NOT_FOUND' | 'FAILED'
export type ProviderName = 'orion' | 'astra' | 'nimbus'
export type PhoneLookupInput = {
  fullName: string
  email: string
  jobTitle: string | null
  companyWebsite: string | null
}

/** The provider refused the request (4xx: bad input or credentials), so retrying won't help.
 * Temporal uses the class name as the failure type, matched by `nonRetryableErrorTypes`. */
export class ProviderRejectedError extends Error {}

type ProviderRequest = {
  path: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body: object
}
type Provider = {
  /** null when the lead lacks an input this provider requires, so it is skipped */
  request: (lead: PhoneLookupInput) => ProviderRequest | null
  parse: (json: Record<string, unknown>) => string | null
}

const BASE_URL = 'https://api.enginy.ai/api/tmp'
const asPhone = (value: unknown) =>
  value === null || value === undefined || value === '' ? null : String(value)

// The abstraction layer: each provider only differs in input, auth and response shape.
// Shapes below were checked against the live APIs, not just the README.
export const providers: Record<ProviderName, Provider> = {
  orion: {
    request: (lead) =>
      lead.companyWebsite
        ? {
            path: 'orionConnect',
            headers: { 'x-auth-me': process.env.ORION_API_KEY ?? '' },
            body: { fullName: lead.fullName, companyWebsite: lead.companyWebsite },
          }
        : null,
    parse: (json) => asPhone(json.phone),
  },
  astra: {
    request: (lead) => ({
      path: 'astraDialer',
      headers: { apiKey: process.env.ASTRA_API_KEY ?? '' },
      body: { email: lead.email },
    }),
    parse: (json) => asPhone(json.phoneNmbr), // missing or null when there is no data
  },
  nimbus: {
    request: (lead) =>
      lead.jobTitle
        ? {
            path: 'numbusLookup', // sic: the real endpoint name
            query: { api: process.env.NIMBUS_API_KEY ?? '' },
            body: { email: lead.email, jobTitle: lead.jobTitle },
          }
        : null,
    // The README documents `number`; the live API returns `phoneNmbr` (a number). Accept both.
    parse: (json) => asPhone(json.phoneNmbr ?? json.number),
  },
}

const FREE_MAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'])

export function toPhoneLookupInput(lead: {
  firstName: string
  lastName: string
  email: string
  jobTitle: string | null
}): PhoneLookupInput {
  const domain = lead.email.split('@')[1]?.toLowerCase()
  return {
    fullName: `${lead.firstName} ${lead.lastName}`.trim(),
    email: lead.email,
    jobTitle: lead.jobTitle,
    // ponytail: company website guessed from the email domain; store a real website field when we collect one
    companyWebsite: domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : null,
  }
}

/** Activity: ask one provider for a phone. null = no data (or provider skipped). Throws to trigger a retry. */
export async function lookupPhone(name: ProviderName, lead: PhoneLookupInput): Promise<string | null> {
  const request = providers[name].request(lead)
  if (!request) return null

  const url = new URL(`${BASE_URL}/${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value)

  // ponytail: no abort on Temporal's timeout (needs @temporalio/activity's cancellation signal); a timed-out attempt finishes in the background
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...request.headers },
    body: JSON.stringify(request.body),
  })
  // 429 and 5xx can succeed on retry (Orion and Nimbus return random 500s); other 4xx cannot.
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new ProviderRejectedError(`${name} rejected the request (${response.status})`)
  }
  if (!response.ok) throw new Error(`${name} responded ${response.status}`)
  return providers[name].parse(await response.json())
}

/** Activity: record the outcome. Only a PENDING lead can move, so stale or duplicate writes do nothing. */
export async function finishPhoneEnrichment(
  leadId: number,
  result: { status: 'FOUND'; phone: string } | { status: 'NOT_FOUND' | 'FAILED' }
) {
  await prisma.lead.updateMany({
    where: { id: leadId, phoneEnrichmentStatus: 'PENDING' },
    data:
      result.status === 'FOUND'
        ? { phoneNumber: result.phone, phoneEnrichmentStatus: 'FOUND' }
        : { phoneEnrichmentStatus: result.status },
  })
}
