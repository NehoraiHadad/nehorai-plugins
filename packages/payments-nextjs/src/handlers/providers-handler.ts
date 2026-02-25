/**
 * @nehorai/payments-nextjs - Providers Route Handler Factory
 *
 * Creates a Next.js App Router GET handler for listing
 * available payment providers and their capabilities.
 */

import { NextResponse } from 'next/server'
import { type PaymentServices } from '@nehorai/payments'

/**
 * Provider display information (caller supplies this)
 */
export interface ProviderDisplayInfo {
  name: string
  displayName: string
  currencies: string[]
  features: string[]
  description: string
  feePercent: number
}

export interface ProvidersHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Provider display information for all known providers */
  providerInfo: ProviderDisplayInfo[]
  /** Routing description text */
  routingDescription?: string
}

export function createProvidersRouteHandler(options: ProvidersHandlerOptions) {
  return async function GET(): Promise<NextResponse> {
    try {
      const configuredNames = new Set(options.services.providers.keys())

      const providers = options.providerInfo.map((info) => ({
        ...info,
        available: configuredNames.has(info.name),
      }))

      // Update currencies from live provider instances
      for (const provider of providers) {
        if (provider.available) {
          const instance = options.services.providers.get(provider.name)
          if (instance) {
            provider.currencies = [...instance.supportedCurrencies]
          }
        }
      }

      // Determine default provider
      const defaultProvider = providers.find((p) => p.available)?.name ?? null

      return NextResponse.json({
        success: true,
        data: {
          providers,
          routing: {
            description: options.routingDescription ?? 'Smart routing based on card BIN and provider priorities',
            defaultProvider,
          },
        },
      })
    } catch (error) {
      console.error('[payments-nextjs] List providers error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }
}
