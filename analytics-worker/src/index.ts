import { buildLiquidityHeatmap, summarizePosition } from '@mde/analytics'
import { createLogger } from '@mde/monitoring'

const logger = createLogger('analytics-worker')

async function main(): Promise<void> {
  logger.info('analytics_worker_started')

  const heatmap = buildLiquidityHeatmap([
    { poolAddress: '0xpool', blockNumber: 1, timestamp: 1, type: 'mint', tickLower: -600, tickUpper: 600, liquidityDelta: '1000' },
    { poolAddress: '0xpool', blockNumber: 2, timestamp: 2, type: 'mint', tickLower: 600, tickUpper: 1200, liquidityDelta: '300' },
    { poolAddress: '0xpool', blockNumber: 3, timestamp: 3, type: 'burn', tickLower: -600, tickUpper: 600, liquidityDelta: '-100' },
  ])

  const position = summarizePosition({
    owner: '0xowner',
    tickLower: -600,
    tickUpper: 600,
    liquidity: '900',
    currentTick: 250,
    realizedPnlUsd: 12.4,
    unrealizedPnlUsd: 44.1,
    accruedFeesUsd: 5.2,
  })

  logger.info('analytics_demo_complete', { heatmap, position })
}

void main()
