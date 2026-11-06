import { FC, useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { api } from '../api'
import { CsvLead, parseCsv } from '../utils/csvParser'

interface CsvImportModalProps {
  isOpen: boolean
  onClose: () => void
}

export const CsvImportModal: FC<CsvImportModalProps> = ({ isOpen, onClose }) => {
  const [csvData, setCsvData] = useState<CsvLead[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const stats = useMemo(() => {
    const validLeads = csvData.filter((lead) => lead.isValid)
    const invalidLeads = csvData.filter((lead) => !lead.isValid)

    const duplicateGroups = new Map<string, CsvLead[]>()
    validLeads.forEach((lead) => {
      const key = `${lead.firstName.toLowerCase()}_${(lead.lastName || '').toLowerCase()}`
      if (!duplicateGroups.has(key)) {
        duplicateGroups.set(key, [])
      }
      duplicateGroups.get(key)!.push(lead)
    })

    const duplicatesInCsv = Array.from(duplicateGroups.values())
      .filter((group) => group.length > 1)
      .flat()

    return {
      total: csvData.length,
      valid: validLeads.length,
      invalid: invalidLeads.length,
      duplicatesInCsv: duplicatesInCsv.length,
    }
  }, [csvData])

  const handleFileSelect = (file: File) => {
    if (!file.name.endsWith('.csv')) {
      toast.error('Please select a CSV file')
      return
    }

    setIsProcessing(true)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string
        const parsed = parseCsv(content)
        setCsvData(parsed)
        setIsProcessing(false)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to parse CSV file'
        toast.error(errorMessage)
        setIsProcessing(false)
      }
    }
    reader.onerror = () => {
      toast.error('Error reading file')
      setIsProcessing(false)
    }
    reader.readAsText(file)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      handleFileSelect(files[0])
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const importMutation = useMutation({
    mutationFn: async (leads: CsvLead[]) => {
      const validLeads = leads.filter((lead) => lead.isValid)

      const leadsToImport = validLeads.map((lead) => ({
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        jobTitle: lead.jobTitle || undefined,
        countryCode: lead.countryCode || undefined,
        companyName: lead.companyName || undefined,
      }))

      return api.leads.bulkImport({ leads: leadsToImport })
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['leads', 'getMany'] })

      let message = `Successfully imported ${data.importedCount} leads!`
      if (data.duplicatesSkipped > 0) {
        message += ` (${data.duplicatesSkipped} duplicates skipped)`
      }
      if (data.invalidLeads > 0) {
        message += ` (${data.invalidLeads} invalid leads excluded)`
      }

      toast.success(message)
      onClose()
      setCsvData([])
    },
    onError: () => {
      toast.error('Error importing leads. Please try again.')
    },
  })

  const handleImport = () => {
    if (stats.valid === 0) {
      toast.error('No valid leads to import')
      return
    }
    importMutation.mutate(csvData)
  }

  const handleClose = useCallback(() => {
    if (!importMutation.isPending) {
      setCsvData([])
      onClose()
    }
  }, [importMutation.isPending, onClose])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      handleClose()
    }
  }

  useEffect(() => {
    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscapeKey)
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscapeKey)
      document.body.style.overflow = 'unset'
    }
  }, [isOpen, handleClose])

  if (!isOpen) return null

  const modalContent = (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium text-gray-900">Import Leads from CSV</h3>
            <button
              onClick={handleClose}
              disabled={importMutation.isPending}
              className="text-gray-400 hover:text-gray-500 focus:outline-none disabled:opacity-50"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-4">
          {csvData.length === 0 ? (
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                isDragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                className="hidden"
              />

              {isProcessing ? (
                <div className="flex flex-col items-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                  <p className="text-gray-600">Processing CSV file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <svg
                    className="w-12 h-12 text-gray-400 mb-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
                    />
                  </svg>
                  <p className="text-lg font-medium text-gray-900 mb-2">
                    Drop your CSV file here, or{' '}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="text-blue-600 hover:text-blue-500"
                    >
                      browse
                    </button>
                  </p>
                  <p className="text-sm text-gray-500">
                    CSV must include: firstName, lastName, email (required). Optional: jobTitle, countryCode,
                    companyName
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Import Summary</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-semibold text-gray-900">{stats.total}</div>
                    <div className="text-xs text-gray-500">Total Rows</div>
                  </div>
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-semibold text-green-600">{stats.valid}</div>
                    <div className="text-xs text-gray-500">Valid Leads</div>
                  </div>
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-semibold text-red-600">{stats.invalid}</div>
                    <div className="text-xs text-gray-500">Invalid Leads</div>
                  </div>
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-semibold text-yellow-600">{stats.duplicatesInCsv}</div>
                    <div className="text-xs text-gray-500">Duplicates in CSV</div>
                  </div>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg max-h-96 overflow-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Row</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Status
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Name
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Email
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Company
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Country
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Errors
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {csvData.map((lead, index) => (
                      <tr key={index} className={lead.isValid ? 'bg-white' : 'bg-red-50'}>
                        <td className="px-3 py-2 text-sm text-gray-900">{lead.rowIndex - 1}</td>
                        <td className="px-3 py-2">
                          {lead.isValid ? (
                            <span className="inline-flex px-2 py-1 text-xs font-semibold text-green-800 bg-green-100 rounded-full">
                              Valid
                            </span>
                          ) : (
                            <span className="inline-flex px-2 py-1 text-xs font-semibold text-red-800 bg-red-100 rounded-full">
                              Invalid
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-900">
                          {lead.firstName} {lead.lastName || ''}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-900">{lead.email || '-'}</td>
                        <td className="px-3 py-2 text-sm text-gray-900">{lead.companyName || '-'}</td>
                        <td className="px-3 py-2 text-sm text-gray-900">{lead.countryCode || '-'}</td>
                        <td className="px-3 py-2 text-sm text-red-600">{lead.errors.join(', ') || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {csvData.length > 0 && (
          <div className="px-6 py-4 border-t border-gray-200 flex justify-between">
            <div className="flex space-x-3">
              <button
                onClick={() => setCsvData([])}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Clear Data
              </button>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={stats.valid === 0 || importMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importMutation.isPending ? 'Importing...' : `Import ${stats.valid} Valid Leads`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return createPortal(modalContent, document.body)
}
