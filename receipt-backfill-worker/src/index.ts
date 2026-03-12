import {
  ExecutionEngine,
  backfillExecutionStatuses,
  loadExecutionReplacementPolicy,
  loadExecutionSignerConfig,
  validateExecutionEnvironment,
} from '@mde/execution'
import { createLogger } from '@mde/monitoring'
import { loadStoreFromEnv } from '@mde/storage'

const logger = createLogger('receipt-backfill-worker')
const engine = new ExecutionEngine()
const store = loadStoreFromEnv()

const config = {
  intervalMs: parsePositiveInteger(process.env.EXECUTION_BACKFILL_INTERVAL_MS, 15_000, 0),
  batchSize: parsePositiveInteger(process.env.EXECUTION_BACKFILL_BATCH_SIZE, 25, 1),
  once: parseBoolean(process.env.EXECUTION_BACKFILL_ONCE),
  waitForReceipt: parseBoolean(process.env.EXECUTION_BACKFILL_WAIT_FOR_RECEIPT),
  forceReplace: parseBoolean(process.env.EXECUTION_BACKFILL_FORCE_REPLACE),
  requiredConfirmations: parsePositiveInteger(process.env.EXECUTION_CONFIRMATIONS, 1, 1),
}

async function cycle(): Promise<void> {
  const results = await backfillExecutionStatuses(store, engine, {
    limit: config.batchSize,
    waitForReceipt: config.waitForReceipt,
    forceReplace: config.forceReplace,
    requiredConfirmations: config.requiredConfirmations,
    replacementPolicy: loadExecutionReplacementPolicy(),
  })

  logger.info('backfill_cycle_complete', {
    count: results.length,
    results,
    store: store.summary(),
  })
}

async function main(): Promise<void> {
  logger.info('receipt_backfill_worker_started', {
    signerConfig: loadExecutionSignerConfig(),
    replacementPolicy: loadExecutionReplacementPolicy(),
    executionConfig: validateExecutionEnvironment(),
    runtimeConfig: config,
    store: store.summary(),
  })

  if (config.once) {
    await cycle()
    return
  }

  while (true) {
    try {
      await cycle()
    } catch (error) {
      logger.error('backfill_cycle_failed', { error: error instanceof Error ? error.message : String(error) })
    }

    if (config.intervalMs <= 0) {
      return
    }

    await sleep(config.intervalMs)
  }
}

void main()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}

function parsePositiveInteger(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, parsed)
}
