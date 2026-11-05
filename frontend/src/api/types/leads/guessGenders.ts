export type LeadsGuessGendersInput = {
  leadIds: number[]
}

export type LeadsGuessGendersOutput = {
  success: boolean
  updatedCount: number
  errors: Array<{
    leadId: number
    leadName: string
    error: string
  }>
}
