import {
  DefaultError,
  QueryClient,
  useMutation,
  UseMutationOptions,
  useQueryClient,
} from '@tanstack/react-query'
import { get } from 'lodash'
import { useMemo } from 'react'
import { Path } from 'ts-toolbelt/out/Object/Path'
import { Split } from 'ts-toolbelt/out/String/Split'
import { api, ApiOutput } from '..'
import { ApiModule } from '../utils'

type ActuallyUseMutationOptions = any
type MutationsApi<T extends ApiModule> = {
  [K in keyof T]?: T[K] extends ApiModule ? MutationsApi<T[K]> : ActuallyUseMutationOptions
}
type ApiMutationsOptions = ReturnType<typeof apiMutationsOptions>
type ApiMutationsOptionsLeaves<TApi extends ApiModule, TMut extends MutationsApi<TApi>> = {
  [K in keyof TMut & keyof TApi]: TApi[K] extends ApiModule
    ? TMut[K] extends MutationsApi<TApi[K]>
      ? ApiMutationsOptionsLeaves<TApi[K], TMut[K]>
      : never
    : true
}
type Leaves<T> = T extends object
  ? {
      [K in keyof T]: `${Exclude<K, symbol>}${Leaves<T[K]> extends never ? '' : `.${Leaves<T[K]>}`}`
    }[keyof T]
  : never
type ApiMutationsPaths = Leaves<ApiMutationsOptionsLeaves<typeof api, ApiMutationsOptions>>
const makeOptions = <TData = unknown, TError = DefaultError, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>
) => options

export const useApiMutation = <P extends ApiMutationsPaths>(endpointPath: P) => {
  type Options = Path<ApiMutationsOptions, Split<P, '.'>>
  const useMutationTyped = useMutation<
    Options extends UseMutationOptions<infer TData, any, any, any> ? TData : unknown,
    Options extends UseMutationOptions<any, infer TError, any, any> ? TError : DefaultError,
    Options extends UseMutationOptions<any, any, infer TVariables, any> ? TVariables : unknown,
    Options extends UseMutationOptions<any, any, any, infer TContext> ? TContext : unknown
  >

  const queryClient = useQueryClient()
  const allOptions = useMemo(() => apiMutationsOptions(queryClient), [queryClient])
  const options = get(allOptions, endpointPath) as Options
  return useMutationTyped(options as any)
}

const apiMutationsOptions = (queryClient: QueryClient) =>
  ({
    leads: {
      create: makeOptions({
        mutationFn: api.leads.create,
        onMutate: async (input) => {
          await queryClient.cancelQueries({ queryKey: ['leads', 'getMany'] })

          const previousValue = queryClient.getQueryData(['leads', 'getMany']) as
            | ApiOutput<typeof api.leads.getMany>
            | undefined

          const newLead: ApiOutput<typeof api.leads.getMany>[number] = {
            id: -1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            jobTitle: null,
            countryCode: null,
            companyName: null,
            message: null,
            emailVerified: null,
            gender: null,
            ...input,
          }
          const newLeads: ApiOutput<typeof api.leads.getMany> = [...(previousValue ?? []), newLead]

          queryClient.setQueryData(['leads', 'getMany'], newLeads)

          return { previousValue, newLeads }
        },
        onError: (_err, _input, context) => {
          if (!context) return
          queryClient.setQueryData(['leads', 'getMany'], context.previousValue)
        },
        onSettled: () => {
          queryClient.invalidateQueries({ queryKey: ['leads', 'getMany'] })
        },
      }),
    },
  }) as const satisfies MutationsApi<typeof api>
