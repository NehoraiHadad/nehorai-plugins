import { NextResponse } from 'next/server'
import { type PaymentServices } from '@nehorai/payments'

export interface HealthHandlerOptions {
  services: PaymentServices
  /** All known provider names to check availability for */
  allProviders?: string[]
}

export function createHealthRouteHandler(options: HealthHandlerOptions) {
  const allProviders = options.allProviders ?? ['stripe', 'hyp', 'cardcom']

  return async function GET(): Promise<NextResponse> {
    try {
      const providerHealth: Array<{
        name: string
        configured: boolean
        healthy: boolean
        avgLatencyMs?: number
        errorRate?: number
      }> = []

      // Check each configured provider
      for (const [name, provider] of options.services.providers) {
        try {
          const health = await provider.getHealth()
          providerHealth.push({
            name,
            configured: true,
            healthy: health.healthy,
            avgLatencyMs: health.avgLatencyMs,
            errorRate: health.errorRate,
          })
        } catch {
          providerHealth.push({
            name,
            configured: true,
            healthy: false,
            errorRate: 1,
          })
        }
      }

      // Add unconfigured providers
      const configuredNames = new Set(providerHealth.map((p) => p.name))
      for (const name of allProviders) {
        if (!configuredNames.has(name)) {
          providerHealth.push({
            name,
            configured: false,
            healthy: false,
          })
        }
      }

      // Determine overall status
      const configuredProviders = providerHealth.filter((p) => p.configured)
      const healthyProviders = configuredProviders.filter((p) => p.healthy)

      let status: 'healthy' | 'degraded' | 'unhealthy'
      if (configuredProviders.length === 0) {
        status = 'unhealthy'
      } else if (healthyProviders.length === configuredProviders.length) {
        status = 'healthy'
      } else if (healthyProviders.length > 0) {
        status = 'degraded'
      } else {
        status = 'unhealthy'
      }

      return NextResponse.json({
        success: true,
        data: {
          status,
          timestamp: new Date().toISOString(),
          providers: providerHealth,
          summary: {
            configured: configuredProviders.length,
            healthy: healthyProviders.length,
          },
        },
      })
    } catch (error) {
      console.error('[payments-nextjs] Health check error:', error)
      return NextResponse.json({
        success: false,
        data: {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      })
    }
  }
}
