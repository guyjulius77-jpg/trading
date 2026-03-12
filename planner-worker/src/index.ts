import { BridgeRouter } from '@mde/bridges'
import { createLogger } from '@mde/monitoring'
import { createDefaultAdapters } from '@mde/protocols'
import { RiskEngine } from '@mde/risk'
import { ExecutionPlanner } from '@mde/routing'

const logger = createLogger('planner-worker')
const planner = new ExecutionPlanner({
  bridgeRouter: new BridgeRouter(),
  adapters: createDefaultAdapters(),
})
const risk = new RiskEngine()

async function main(): Promise<void> {
  logger.info('planner_worker_started')

  const intent = {
    intentId: 'demo-intent',
    strategyType: 'cross_exchange_arbitrage' as const,
    sourceChain: 'arbitrum',
    inputAssets: ['USDC'],
    outputAssets: ['USDC'],
    amountIn: '1000000',
    maxSlippageBps: 50,
    requireFlashLiquidity: true,
    allowedProtocols: ['aave_v3', 'uniswap_v3'],
    deadlineMs: Date.now() + 120000,
    metadata: {
      cycleAssets: ['USDC', 'WETH', 'USDC'],
    },
  }

  const routes = await planner.plan(intent)
  const evaluations = await Promise.all(routes.map((route) => risk.evaluate(route)))

  logger.info('planner_demo_complete', {
    planned: routes.length,
    topRoute: routes[0],
    topEvaluation: evaluations[0],
  })
}

void main()
