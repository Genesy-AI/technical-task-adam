import { PrismaClient } from '@prisma/client'

// One client for the API and the worker's activities (same process).
export const prisma = new PrismaClient()
