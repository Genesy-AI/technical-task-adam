import { PrismaClient } from '@prisma/client'
import express, { Request, Response } from 'express'
import { Connection, Client } from '@temporalio/client'
import { verifyEmailWorkflow } from './workflows'
import { generateMessageFromTemplate } from './utils/messageGenerator'
import { runTemporalWorker } from './worker'
const prisma = new PrismaClient()

// One Temporal connection for the process instead of one per request.
let temporalClient: Promise<Client> | undefined
const getTemporalClient = () =>
  (temporalClient ??= Connection.connect({ address: 'localhost:7233' }).then(
    (connection) => new Client({ connection, namespace: 'default' })
  ))
export const app = express()
app.use(express.json())

app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.sendStatus(200)
    return
  }

  next()
})

app.post('/leads', async (req: Request, res: Response) => {
  const { name, lastName, email } = req.body

  if (!name || !lastName || !email) {
    return res.status(400).json({ error: 'firstName, lastName, and email are required' })
  }

  const lead = await prisma.lead.create({
    data: {
      firstName: String(name),
      lastName: String(lastName),
      email: String(email),
    },
  })
  res.json(lead)
})

app.get('/leads/:id', async (req: Request, res: Response) => {
  const { id } = req.params
  const lead = await prisma.lead.findUnique({
    where: {
      id: Number(id),
    },
  })
  res.json(lead)
})

app.get('/leads', async (req: Request, res: Response) => {
  const leads = await prisma.lead.findMany()

  res.json(leads)
})

app.patch('/leads/:id', async (req: Request, res: Response) => {
  const { id } = req.params
  const { name, email } = req.body
  const lead = await prisma.lead.update({
    where: {
      id: Number(id),
    },
    data: {
      firstName: String(name),
      email: String(email),
    },
  })
  res.json(lead)
})

app.delete('/leads/:id', async (req: Request, res: Response) => {
  const { id } = req.params
  await prisma.lead.delete({
    where: {
      id: Number(id),
    },
  })
  res.json()
})

app.delete('/leads', async (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body is required and must be valid JSON' })
  }

  const { ids } = req.body

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' })
  }

  try {
    const result = await prisma.lead.deleteMany({
      where: {
        id: {
          in: ids.map((id) => Number(id)),
        },
      },
    })

    res.json({ deletedCount: result.count })
  } catch (error) {
    console.error('Error deleting leads:', error)
    res.status(500).json({ error: 'Failed to delete leads' })
  }
})

app.post('/leads/generate-messages', async (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body is required and must be valid JSON' })
  }

  const { leadIds, template } = req.body

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: 'leadIds must be a non-empty array' })
  }

  if (!template || typeof template !== 'string') {
    return res.status(400).json({ error: 'template must be a non-empty string' })
  }

  try {
    const leads = await prisma.lead.findMany({
      where: {
        id: {
          in: leadIds.map((id) => Number(id)),
        },
      },
    })

    if (leads.length === 0) {
      return res.status(404).json({ error: 'No leads found with the provided IDs' })
    }

    let generatedCount = 0
    const errors: Array<{ leadId: number; leadName: string; error: string }> = []

    for (const lead of leads) {
      try {
        const message = generateMessageFromTemplate(template, lead)

        await prisma.lead.update({
          where: { id: lead.id },
          data: { message },
        })

        generatedCount++
      } catch (error) {
        errors.push({
          leadId: lead.id,
          leadName: `${lead.firstName} ${lead.lastName}`.trim(),
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    res.json({
      success: true,
      generatedCount,
      errors,
    })
  } catch (error) {
    console.error('Error generating messages:', error)
    res.status(500).json({ error: 'Failed to generate messages' })
  }
})

app.post('/leads/bulk', async (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body is required and must be valid JSON' })
  }

  const { leads } = req.body

  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'leads must be a non-empty array' })
  }

  try {
    const validLeads = leads.filter((lead) => {
      return (
        lead.firstName &&
        lead.lastName &&
        lead.email &&
        typeof lead.firstName === 'string' &&
        lead.firstName.trim() &&
        typeof lead.lastName === 'string' &&
        lead.lastName.trim() &&
        typeof lead.email === 'string' &&
        lead.email.trim()
      )
    })

    if (validLeads.length === 0) {
      return res
        .status(400)
        .json({ error: 'No valid leads found. firstName, lastName, and email are required.' })
    }

    const existingLeads = await prisma.lead.findMany({
      where: {
        OR: validLeads.map((lead) => ({
          AND: [{ firstName: lead.firstName.trim() }, { lastName: lead.lastName.trim() }],
        })),
      },
    })

    const leadKeys = new Set(
      existingLeads.map((lead) => `${lead.firstName.toLowerCase()}_${(lead.lastName || '').toLowerCase()}`)
    )

    const uniqueLeads = validLeads.filter((lead) => {
      const key = `${lead.firstName.toLowerCase()}_${lead.lastName.toLowerCase()}`
      return !leadKeys.has(key)
    })

    let importedCount = 0
    const errors: Array<{ lead: any; error: string }> = []

    for (const lead of uniqueLeads) {
      try {
        await prisma.lead.create({
          data: {
            firstName: lead.firstName.trim(),
            lastName: lead.lastName.trim(),
            email: lead.email.trim(),
            jobTitle: lead.jobTitle ? lead.jobTitle.trim() : null,
            countryCode: lead.countryCode ? lead.countryCode.trim() : null,
            companyName: lead.companyName ? lead.companyName.trim() : null,
          },
        })
        importedCount++
      } catch (error) {
        errors.push({
          lead: lead,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    res.json({
      success: true,
      importedCount,
      duplicatesSkipped: validLeads.length - uniqueLeads.length,
      invalidLeads: leads.length - validLeads.length,
      errors,
    })
  } catch (error) {
    console.error('Error importing leads:', error)
    res.status(500).json({ error: 'Failed to import leads' })
  }
})

app.post('/leads/verify-emails', async (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body is required and must be valid JSON' })
  }

  const { leadIds } = req.body as { leadIds?: number[] }

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: 'leadIds must be a non-empty array' })
  }

  try {
    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds.map((id) => Number(id)) } },
    })

    if (leads.length === 0) {
      return res.status(404).json({ error: 'No leads found with the provided IDs' })
    }

    const client = await getTemporalClient()

    // In parallel: the request takes as long as the slowest lead, not the sum of all of them.
    const outcomes = await Promise.allSettled(
      leads.map(async (lead) => {
        const emailVerified = await client.workflow.execute(verifyEmailWorkflow, {
          taskQueue: 'myQueue',
          workflowId: `verify-email-${lead.id}`, // one run per lead at a time
          workflowIdConflictPolicy: 'USE_EXISTING', // a double click joins the running workflow
          args: [lead.email],
        })
        await prisma.lead.update({ where: { id: lead.id }, data: { emailVerified } })
        return { leadId: lead.id, emailVerified }
      })
    )

    const results: Array<{ leadId: number; emailVerified: boolean }> = []
    const errors: Array<{ leadId: number; leadName: string; error: string }> = []
    // A failed check leaves emailVerified untouched (null = unknown), never false (= invalid).
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
      } else {
        errors.push({
          leadId: leads[i].id,
          leadName: `${leads[i].firstName} ${leads[i].lastName}`.trim(),
          error: outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error',
        })
      }
    })

    res.json({ success: true, verifiedCount: results.length, results, errors })
  } catch (error) {
    console.error('Error verifying emails:', error)
    res.status(500).json({ error: 'Failed to verify emails' })
  }
})

// Only start the server and worker when run directly (nodemon / node), not when imported by tests.
if (require.main === module) {
  app.listen(4000, () => {
    console.log('Express server is running on port 4000')
  })

  runTemporalWorker().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
