import http from 'node:http'
import { URL } from 'node:url'
import { BridgeRouter } from '@mde/bridges'
import { ChainRegistry } from '@mde/chains'
import {
  ExecutionEngine,
  backfillExecutionStatuses,
  createExecutionJob,
  loadExecutionPreflightPolicy,
  loadExecutionReplacementPolicy,
  loadExecutionSignerConfig,
  validateExecutionEnvironment,
} from '@mde/execution'
import type { ExecutionPayload, PlannedRoute, RiskEvaluation, TradeIntent } from '@mde/domain'
import { createLogger } from '@mde/monitoring'
import {
  ProtocolRegistry,
  createDefaultAdapters,
  discoverAaveV3Reserve,
  discoverUniswapV3Pools,
  getBuiltinAssetAddressBook,
  resolveRpcUrl,
} from '@mde/protocols'
import { RiskEngine } from '@mde/risk'
import { ExecutionPlanner } from '@mde/routing'
import { loadStoreFromEnv } from '@mde/storage'

const logger = createLogger('engine-api')
const chainRegistry = new ChainRegistry()
const protocolRegistry = new ProtocolRegistry()
const bridgeRouter = new BridgeRouter()
const adapters = createDefaultAdapters()
const planner = new ExecutionPlanner({ bridgeRouter, adapters })
const risk = new RiskEngine()
const store = loadStoreFromEnv()
const executor = new ExecutionEngine({ chainRegistry })

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(data, null, 2))
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function getRequestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}

function parseProtocols(raw: string | null, fallback: string[]): string[] {
  if (!raw?.trim()) return fallback
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function buildDemoIntent(options: { chainKey?: string; flashSource?: string; swapProtocols?: string[] } = {}): TradeIntent {
  const chainKey = options.chainKey ?? 'arbitrum'
  const flashSource = options.flashSource ?? 'aave_v3'
  const swapProtocols = options.swapProtocols?.length ? options.swapProtocols : ['uniswap_v3']

  return {
    intentId: `demo-intent:${chainKey}:${Date.now()}`,
    strategyType: 'cross_exchange_arbitrage',
    sourceChain: chainKey,
    inputAssets: ['USDC'],
    outputAssets: ['USDC'],
    amountIn: '1000000',
    maxSlippageBps: 50,
    requireFlashLiquidity: true,
    allowedProtocols: [...new Set([flashSource, ...swapProtocols])],
    deadlineMs: Date.now() + 120000,
    metadata: {
      cycleAssets: ['USDC', 'WETH', 'USDC'],
    },
  }
}

function buildLiveDemoIntent(
  chainKey = 'ethereum',
  flashSource = 'aave_v3',
  swapProtocols: string[] = ['uniswap_v3']
): TradeIntent {
  const builtins = getBuiltinAssetAddressBook(chainKey)
  if (!builtins.USDC || !builtins.WETH) {
    throw new Error(`No built-in live demo asset mapping configured for ${chainKey}`)
  }

  return {
    intentId: `demo-live-intent:${chainKey}:${Date.now()}`,
    strategyType: 'cross_exchange_arbitrage',
    sourceChain: chainKey,
    inputAssets: [builtins.USDC],
    outputAssets: [builtins.USDC],
    amountIn: '1000000',
    maxSlippageBps: 50,
    requireFlashLiquidity: true,
    allowedProtocols: [...new Set([flashSource, ...swapProtocols])],
    deadlineMs: Date.now() + 120000,
    metadata: {
      cycleAssets: ['USDC', 'WETH', 'USDC'],
      assetAddresses: {
        USDC: builtins.USDC,
        WETH: builtins.WETH,
      },
      liveDiscovery: true,
    },
  }
}

function parseIntentEnvelope(body: unknown): { intent: TradeIntent; waitForReceipt?: boolean } {
  const record = isRecord(body) ? body : {}
  const candidate = isRecord(record.intent) ? record.intent : record
  const intent = (typeof candidate.intentId === 'string' ? candidate : buildDemoIntent()) as TradeIntent
  return {
    intent,
    waitForReceipt: parseOptionalBoolean(record.waitForReceipt),
  }
}

async function planIntent(intent: TradeIntent): Promise<{ intent: TradeIntent; routes: PlannedRoute[]; evaluations: RiskEvaluation[] }> {
  store.saveIntent(intent)
  const routes = await planner.plan(intent)
  routes.forEach((route) => store.saveRoute(route))
  const evaluations = await Promise.all(routes.map((route) => risk.evaluate(route)))
  return { intent, routes, evaluations }
}

type PreparedExecution =
  | {
      ok: false
      reason: 'no_approved_route' | 'missing_adapter'
      intent: TradeIntent
      routes: PlannedRoute[]
      evaluations: RiskEvaluation[]
      route?: PlannedRoute
    }
  | {
      ok: true
      intent: TradeIntent
      routes: PlannedRoute[]
      evaluations: RiskEvaluation[]
      route: PlannedRoute
      evaluation: RiskEvaluation
      payload: ExecutionPayload
      job: ReturnType<typeof createExecutionJob>
    }

async function prepareExecution(intent: TradeIntent): Promise<PreparedExecution> {
  const { routes, evaluations } = await planIntent(intent)
  const approvedIndex = evaluations.findIndex((evaluation) => evaluation.approved)

  if (approvedIndex < 0) {
    return {
      ok: false,
      reason: 'no_approved_route',
      intent,
      routes,
      evaluations,
    }
  }

  const route = routes[approvedIndex]
  const adapter = adapters[route.protocolKeys[0]]
  if (!adapter) {
    return {
      ok: false,
      reason: 'missing_adapter',
      intent,
      routes,
      evaluations,
      route,
    }
  }

  const payload = await adapter.buildExecution(route)
  const job = createExecutionJob(intent, route)

  return {
    ok: true,
    intent,
    routes,
    evaluations,
    route,
    evaluation: evaluations[approvedIndex],
    payload,
    job,
  }
}

async function simulateIntent(intent: TradeIntent) {
  const prepared = await prepareExecution(intent)
  if (!prepared.ok) return prepared

  return {
    ok: true,
    intent: prepared.intent,
    route: prepared.route,
    evaluation: prepared.evaluation,
    payload: prepared.payload,
    job: prepared.job,
    simulation: await executor.simulate(prepared.job, prepared.payload),
  }
}

async function executeIntent(intent: TradeIntent, options: { waitForReceipt?: boolean } = {}) {
  const prepared = await prepareExecution(intent)
  if (!prepared.ok) return prepared

  store.saveJob(prepared.job)
  store.saveExecutionPayload(prepared.job.jobId, prepared.payload)
  const status = await executor.submit(prepared.job, prepared.payload, { waitForReceipt: options.waitForReceipt })
  store.saveExecutionStatus(prepared.job.jobId, status)

  return {
    ok: status.status !== 'failed',
    route: prepared.route,
    evaluation: prepared.evaluation,
    job: store.getJob(prepared.job.jobId),
    payload: prepared.payload,
    status,
  }
}

function liveRpcChains(): string[] {
  return chainRegistry
    .list()
    .filter((chain) => Boolean(resolveRpcUrl(chain.chainKey, chain.rpcUrls)))
    .map((chain) => chain.chainKey)
}

function jobView(jobId: string) {
  const job = store.getJob(jobId)
  if (!job) return undefined

  return {
    job,
    route: store.getRoute(job.routeId),
    payload: store.getExecutionPayload(jobId),
    status: store.getExecutionStatus(jobId),
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = getRequestUrl(req)
    const jobTransactionMatch = url.pathname.match(/^\/jobs\/([^/]+)\/transaction$/)
    const jobReplaceMatch = url.pathname.match(/^\/jobs\/([^/]+)\/replace$/)
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/)
    const txMatch = url.pathname.match(/^\/transactions\/(0x[a-fA-F0-9]{64})$/)

    if (req.method === 'GET' && url.pathname === '/health') {
      const rpcChains = liveRpcChains()
      const executionConfig = validateExecutionEnvironment({
        chainRegistry,
        chainKeys: [...new Set(['ethereum', 'arbitrum', 'base', ...rpcChains])],
      })
      return sendJson(res, 200, {
        ok: executionConfig.ok,
        milestone: 'milestone-6',
        payloadEncoding: 'evm_selector_plus_abi_bytes',
        signerConfig: loadExecutionSignerConfig(),
        preflightPolicy: loadExecutionPreflightPolicy(),
        replacementPolicy: loadExecutionReplacementPolicy(),
        liveRpcChains: rpcChains,
        executionConfig,
        store: store.summary(),
      })
    }

    if (req.method === 'GET' && url.pathname === '/config/validate') {
      return sendJson(res, 200, validateExecutionEnvironment({ chainRegistry }))
    }

    if (req.method === 'GET' && url.pathname === '/supported-protocols') {
      return sendJson(res, 200, {
        flashSources: ['aave_v3', 'dydx'],
        swapProtocols: ['uniswap_v3', 'pancakeswap', 'sushiswap', 'curve'],
        preflightPolicy: loadExecutionPreflightPolicy(),
        signerConfig: loadExecutionSignerConfig(),
        replacementPolicy: loadExecutionReplacementPolicy(),
      })
    }

    if (req.method === 'GET' && url.pathname === '/chains') {
      return sendJson(res, 200, chainRegistry.list())
    }

    if (req.method === 'GET' && url.pathname === '/deployments') {
      return sendJson(res, 200, protocolRegistry.list())
    }

    if (req.method === 'GET' && url.pathname === '/demo-intent') {
      const chainKey = url.searchParams.get('chainKey') ?? 'arbitrum'
      const flashSource = url.searchParams.get('flashSource') ?? 'aave_v3'
      const swapProtocols = parseProtocols(url.searchParams.get('swapProtocols'), ['uniswap_v3'])
      return sendJson(res, 200, buildDemoIntent({ chainKey, flashSource, swapProtocols }))
    }

    if (req.method === 'GET' && url.pathname === '/demo-live-intent') {
      const chainKey = url.searchParams.get('chainKey') ?? 'ethereum'
      const flashSource = url.searchParams.get('flashSource') ?? 'aave_v3'
      const swapProtocols = parseProtocols(url.searchParams.get('swapProtocols'), ['uniswap_v3'])
      return sendJson(res, 200, buildLiveDemoIntent(chainKey, flashSource, swapProtocols))
    }

    if (req.method === 'GET' && url.pathname === '/discover/aave') {
      const chainKey = url.searchParams.get('chainKey') ?? 'ethereum'
      const asset = url.searchParams.get('asset') ?? 'USDC'
      const addressBook = getBuiltinAssetAddressBook(chainKey)
      const snapshot = await discoverAaveV3Reserve({ chainKey, asset, addressBook })
      return sendJson(res, snapshot ? 200 : 404, snapshot ?? { error: 'reserve_not_found_or_live_rpc_unavailable' })
    }

    if (req.method === 'GET' && url.pathname === '/discover/uniswap') {
      const chainKey = url.searchParams.get('chainKey') ?? 'ethereum'
      const tokenIn = url.searchParams.get('tokenIn') ?? 'USDC'
      const tokenOut = url.searchParams.get('tokenOut') ?? 'WETH'
      const amountIn = url.searchParams.get('amountIn') ?? '1000000'
      const addressBook = getBuiltinAssetAddressBook(chainKey)
      const pools = await discoverUniswapV3Pools({ chainKey, tokenIn, tokenOut, amountIn, addressBook })
      return sendJson(res, pools.length > 0 ? 200 : 404, pools.length > 0 ? pools : { error: 'pools_not_found_or_live_rpc_unavailable' })
    }

    if (req.method === 'GET' && url.pathname === '/store') {
      return sendJson(res, 200, store.summary())
    }

    if (req.method === 'GET' && url.pathname === '/executions') {
      return sendJson(res, 200, store.listJobs().map((job) => jobView(job.jobId)))
    }

    if (req.method === 'GET' && jobTransactionMatch) {
      const jobId = decodeURIComponent(jobTransactionMatch[1])
      const job = store.getJob(jobId)
      const payload = store.getExecutionPayload(jobId)
      if (!job || !payload) {
        return sendJson(res, 404, { error: 'job_or_payload_not_found' })
      }

      const existingStatus = store.getExecutionStatus(jobId)
      const transaction = existingStatus?.transaction ?? (await executor.prepareTransaction(job, payload))
      return sendJson(res, 200, {
        jobId,
        chainKey: job.executionChainKey ?? payload.chainKey,
        transaction,
        status: existingStatus,
      })
    }

    if (req.method === 'GET' && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1])
      const view = jobView(jobId)
      return sendJson(res, view ? 200 : 404, view ?? { error: 'job_not_found' })
    }

    if (req.method === 'GET' && txMatch) {
      const txHash = txMatch[1]
      const job = store.findJobByTxHash(txHash)
      const chainKey = url.searchParams.get('chainKey') ?? job?.executionChainKey
      if (!chainKey) {
        return sendJson(res, 400, { error: 'chain_key_required' })
      }

      const status = await executor.monitor(chainKey, txHash)
      if (job) {
        store.saveExecutionStatus(job.jobId, status)
      }

      return sendJson(res, 200, {
        chainKey,
        jobId: job?.jobId,
        status,
      })
    }

    if (req.method === 'POST' && url.pathname === '/plan') {
      const body = parseIntentEnvelope(await readBody(req))
      return sendJson(res, 200, await planIntent(body.intent))
    }

    if (req.method === 'POST' && url.pathname === '/simulate') {
      const body = parseIntentEnvelope(await readBody(req))
      const result = await simulateIntent(body.intent)
      return sendJson(res, result.ok ? 200 : 422, result)
    }

    if (req.method === 'POST' && url.pathname === '/execute') {
      const body = parseIntentEnvelope(await readBody(req))
      const result = await executeIntent(body.intent, { waitForReceipt: body.waitForReceipt })
      return sendJson(res, result.ok ? 200 : 422, result)
    }

    if (req.method === 'POST' && jobReplaceMatch) {
      const jobId = decodeURIComponent(jobReplaceMatch[1])
      const parsedBody = await readBody(req)
      const body = isRecord(parsedBody) ? parsedBody : {}
      const job = store.getJob(jobId)
      const payload = store.getExecutionPayload(jobId)
      const currentStatus = store.getExecutionStatus(jobId)

      if (!job || !payload || !currentStatus) {
        return sendJson(res, 404, { error: 'job_payload_or_status_not_found' })
      }

      const status = await executor.replace(job, payload, currentStatus, {
        waitForReceipt: parseOptionalBoolean(body.waitForReceipt),
        force: parseOptionalBoolean(body.force),
      })
      store.saveExecutionStatus(jobId, status)
      return sendJson(res, status.status === 'failed' ? 422 : 200, {
        job: store.getJob(jobId),
        status,
        previousStatus: currentStatus,
      })
    }

    if (req.method === 'POST' && url.pathname === '/transactions/submit-raw') {
      const parsedBody = await readBody(req)
      const body = isRecord(parsedBody) ? parsedBody : {}
      const jobId = typeof body.jobId === 'string' ? body.jobId : undefined
      const rawTransaction = typeof body.rawTransaction === 'string' ? body.rawTransaction : undefined
      const job = jobId ? store.getJob(jobId) : undefined
      const chainKey = typeof body.chainKey === 'string' ? body.chainKey : job?.executionChainKey
      const waitForReceipt = parseOptionalBoolean(body.waitForReceipt)

      if (!chainKey || !rawTransaction) {
        return sendJson(res, 400, { error: 'chain_key_and_raw_transaction_required' })
      }

      const status = await executor.submitRaw(chainKey, rawTransaction, { waitForReceipt })
      if (jobId && job) {
        store.saveExecutionStatus(jobId, status)
      }

      return sendJson(res, status.status === 'failed' ? 422 : 200, {
        chainKey,
        jobId,
        status,
      })
    }

    if (req.method === 'POST' && url.pathname === '/backfill') {
      const parsedBody = await readBody(req)
      const body = isRecord(parsedBody) ? parsedBody : {}
      const jobId = typeof body.jobId === 'string' ? body.jobId : undefined
      if (jobId && !store.getJob(jobId)) {
        return sendJson(res, 404, { error: 'job_not_found' })
      }

      const results = await backfillExecutionStatuses(store, executor, {
        jobId,
        limit: parseOptionalInteger(body.limit),
        requiredConfirmations: parseOptionalInteger(body.requiredConfirmations),
        waitForReceipt: parseOptionalBoolean(body.waitForReceipt),
        forceReplace: parseOptionalBoolean(body.forceReplace),
      })

      return sendJson(res, 200, {
        count: results.length,
        results,
        store: store.summary(),
      })
    }

    return sendJson(res, 404, { error: 'not_found' })
  } catch (error) {
    logger.error('request_failed', { error: error instanceof Error ? error.message : String(error) })
    return sendJson(res, 500, { error: 'internal_error' })
  }
})

server.listen(3000, () => logger.info('engine_api_listening', { port: 3000 }))
