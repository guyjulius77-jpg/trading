import { BridgeRouter } from '@mde/bridges'
import {
  ExecutionEngine,
  createExecutionJob,
  loadExecutionReplacementPolicy,
  loadExecutionSignerConfig,
  validateExecutionEnvironment,
} from '@mde/execution'
import { createLogger } from '@mde/monitoring'
import { createDefaultAdapters } from '@mde/protocols'
import { RiskEngine } from '@mde/risk'
import { ExecutionPlanner } from '@mde/routing'
import { ConcurrencyManager } from '@mde/scheduler'
import { loadStoreFromEnv } from '@mde/storage'

const logger = createLogger('executor-worker')
const engine = new ExecutionEngine()
const scheduler = new ConcurrencyManager()
const adapters = createDefaultAdapters()
const planner = new ExecutionPlanner({
  bridgeRouter: new BridgeRouter(),
  adapters,
})
const risk = new RiskEngine()
const store = loadStoreFromEnv()

async function main(): Promise<void> {
  logger.info('executor_worker_started', {
    signerConfig: loadExecutionSignerConfig(),
    replacementPolicy: loadExecutionReplacementPolicy(),
    executionConfig: validateExecutionEnvironment(),
    store: store.summary(),
  })

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
  const approvedIndex = evaluations.findIndex((evaluation) => evaluation.approved)

  if (approvedIndex < 0) {
    logger.warn('executor_no_approved_route', { routes, evaluations })
    return
  }

  const route = routes[approvedIndex]
  const adapter = adapters[route.protocolKeys[0]]
  if (!adapter) {
    logger.error('executor_missing_adapter', { routeId: route.routeId })
    return
  }

  const job = createExecutionJob(intent, route)
  const admitted = scheduler.schedule([], [job])
  logger.info('executor_jobs_admitted', { count: admitted.length })

  if (admitted.length > 0) {
    const payload = await adapter.buildExecution(route)
    store.saveIntent(intent)
    store.saveRoute(route)
    store.saveJob(job)
    store.saveExecutionPayload(job.jobId, payload)

    const status = await engine.submit(job, payload)
    store.saveExecutionStatus(job.jobId, status)

    logger.info('executor_submit_result', {
      route,
      evaluation: evaluations[approvedIndex],
      payload,
      status,
      storedJob: store.getJob(job.jobId),
    })

    if ((status.status === 'submitted' || status.status === 'pending') && job.executionChainKey && status.txHash) {
      const monitored = await engine.monitor(job.executionChainKey, status.txHash)
      store.saveExecutionStatus(job.jobId, monitored)
      logger.info('executor_tx_status', { jobId: job.jobId, monitored, storedJob: store.getJob(job.jobId) })
    }
  }
}

void main()
