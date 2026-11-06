export type LeadsEnrichPhonesInput = {
  leadIds: number[]
}

export type LeadsEnrichPhonesOutput = {
  started: number
  skipped: number
  failedToStart: number
}
