import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExecutionJob, ExecutionJobStatus, ExecutionPayload, ExecutionStatus, PlannedRoute, TradeIntent } from '@mde/domain'

export type StoreSnapshot = {
  version: number
  intents: TradeIntent[]
  routes: PlannedRoute[]
  jobs: ExecutionJob[]
  executionStatuses: Array<{ jobId: string; status: ExecutionStatus }>
  executionPayloads: Array<{ jobId: string; payload: ExecutionPayload }>
  txToJobId: Array<[string, string]>
  logs: Array<Record<string, unknown>>
  savedAtMs: number
}

export class InMemoryStore {
  readonly intents = new Map<string, TradeIntent>()
  readonly routes = new Map<string, PlannedRoute>()
  readonly jobs = new Map<string, ExecutionJob>()
  readonly executionStatuses = new Map<string, ExecutionStatus>()
  readonly executionPayloads = new Map<string, ExecutionPayload>()
  readonly txToJobId = new Map<string, string>()
  readonly logs: Array<Record<string, unknown>> = []

  saveIntent(intent: TradeIntent): void {
    this.intents.set(intent.intentId, intent)
    this.persist()
  }

  saveRoute(route: PlannedRoute): void {
    this.routes.set(route.routeId, route)
    this.persist()
  }

  saveJob(job: ExecutionJob): void {
    this.jobs.set(job.jobId, job)
    this.persist()
  }

  saveExecutionPayload(jobId: string, payload: ExecutionPayload): void {
    this.executionPayloads.set(jobId, payload)
    this.persist()
  }

  updateJobStatus(jobId: string, status: ExecutionJobStatus): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    this.jobs.set(jobId, { ...job, status, lastUpdatedMs: Date.now() })
    this.persist()
  }

  saveExecutionStatus(jobId: string, status: ExecutionStatus): void {
    this.executionStatuses.set(jobId, status)
    const normalizedTxHash = normalizeTxHash(status.txHash)
    if (normalizedTxHash && !isZeroHash(normalizedTxHash)) {
      this.txToJobId.set(normalizedTxHash, jobId)
    }

    const job = this.jobs.get(jobId)
    if (!job) {
      this.persist()
      return
    }

    const previousTxHash = normalizeTxHash(job.submittedTxHash)
    const currentTxHash = normalizedTxHash && !isZeroHash(normalizedTxHash) ? normalizedTxHash : undefined
    const isNewSubmittedTx = Boolean(currentTxHash && currentTxHash !== previousTxHash)
    const replacementTxHashes = [...(job.replacementTxHashes ?? [])]
    if (isNewSubmittedTx && previousTxHash && !isZeroHash(previousTxHash)) {
      replacementTxHashes.push(status.txHash)
    }

    const priorAttempts = job.submitAttempts ?? (previousTxHash && !isZeroHash(previousTxHash) ? 1 : 0)
    const nextAttempts = isNewSubmittedTx ? priorAttempts + 1 : priorAttempts
    const lastSubmittedMs = isNewSubmittedTx ? status.observedAtMs ?? Date.now() : job.lastSubmittedMs

    this.jobs.set(jobId, {
      ...job,
      status: mapExecutionStatusToJobStatus(status.status),
      submittedTxHash: currentTxHash ? status.txHash : job.submittedTxHash,
      submittedVia: status.submittedVia ?? job.submittedVia,
      nonce: status.nonce ?? job.nonce,
      lastErrorReason: status.errorReason ?? job.lastErrorReason,
      lastUpdatedMs: status.observedAtMs ?? Date.now(),
      lastSubmittedMs,
      submitAttempts: nextAttempts,
      replacementTxHashes: replacementTxHashes.length > 0 ? replacementTxHashes : job.replacementTxHashes,
      receiptBlockNumber: status.receipt?.blockNumber ?? status.blockNumber ?? job.receiptBlockNumber,
      confirmations: status.confirmations ?? job.confirmations,
    })

    this.persist()
  }

  findRoutesForIntent(intentId: string): PlannedRoute[] {
    return [...this.routes.values()].filter((route) => route.intentId === intentId)
  }

  listJobs(filters: { statuses?: ExecutionJobStatus[]; chainKey?: string } = {}): ExecutionJob[] {
    return [...this.jobs.values()].filter((job) => {
      if (filters.statuses?.length && !filters.statuses.includes(job.status)) {
        return false
      }
      if (filters.chainKey && job.executionChainKey !== filters.chainKey) {
        return false
      }
      return true
    })
  }

  getJob(jobId: string): ExecutionJob | undefined {
    return this.jobs.get(jobId)
  }

  getExecutionStatus(jobId: string): ExecutionStatus | undefined {
    return this.executionStatuses.get(jobId)
  }

  getExecutionPayload(jobId: string): ExecutionPayload | undefined {
    return this.executionPayloads.get(jobId)
  }

  getRoute(routeId: string): PlannedRoute | undefined {
    return this.routes.get(routeId)
  }

  findJobIdByTxHash(txHash: string): string | undefined {
    return this.txToJobId.get(normalizeTxHash(txHash) ?? '')
  }

  findJobByTxHash(txHash: string): ExecutionJob | undefined {
    const jobId = this.findJobIdByTxHash(txHash)
    return jobId ? this.jobs.get(jobId) : undefined
  }

  appendLog(entry: Record<string, unknown>): void {
    this.logs.push({ ts: new Date().toISOString(), ...entry })
    this.persist()
  }

  snapshot(): StoreSnapshot {
    return {
      version: 2,
      intents: [...this.intents.values()],
      routes: [...this.routes.values()],
      jobs: [...this.jobs.values()],
      executionStatuses: [...this.executionStatuses.entries()].map(([jobId, status]) => ({ jobId, status })),
      executionPayloads: [...this.executionPayloads.entries()].map(([jobId, payload]) => ({ jobId, payload })),
      txToJobId: [...this.txToJobId.entries()],
      logs: [...this.logs],
      savedAtMs: Date.now(),
    }
  }

  restore(snapshot: Partial<StoreSnapshot> | undefined): void {
    this.intents.clear()
    this.routes.clear()
    this.jobs.clear()
    this.executionStatuses.clear()
    this.executionPayloads.clear()
    this.txToJobId.clear()
    this.logs.length = 0

    for (const intent of snapshot?.intents ?? []) {
      this.intents.set(intent.intentId, intent)
    }

    for (const route of snapshot?.routes ?? []) {
      this.routes.set(route.routeId, route)
    }

    for (const job of snapshot?.jobs ?? []) {
      this.jobs.set(job.jobId, job)
    }

    for (const entry of snapshot?.executionStatuses ?? []) {
      this.executionStatuses.set(entry.jobId, entry.status)
    }

    for (const entry of snapshot?.executionPayloads ?? []) {
      this.executionPayloads.set(entry.jobId, entry.payload)
    }

    for (const [txHash, jobId] of snapshot?.txToJobId ?? []) {
      this.txToJobId.set(txHash.toLowerCase(), jobId)
    }

    for (const entry of snapshot?.logs ?? []) {
      this.logs.push(entry)
    }
  }

  summary(): Record<string, unknown> {
    return {
      intents: this.intents.size,
      routes: this.routes.size,
      jobs: this.jobs.size,
      executionStatuses: this.executionStatuses.size,
      executionPayloads: this.executionPayloads.size,
      logs: this.logs.length,
      persistent: false,
    }
  }

  protected persist(): void {
    // in-memory store is intentionally ephemeral
  }
}

export class FileBackedStore extends InMemoryStore {
  readonly filePath: string

  constructor(filePath: string) {
    super()
    this.filePath = path.resolve(filePath)
    this.loadFromDisk()
  }

  flush(): void {
    this.persist()
  }

  summary(): Record<string, unknown> {
    return {
      ...super.summary(),
      persistent: true,
      filePath: this.filePath,
    }
  }

  protected persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(this.snapshot(), null, 2), 'utf8')
    fs.renameSync(tempPath, this.filePath)
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return
    }

    const raw = fs.readFileSync(this.filePath, 'utf8').trim()
    if (!raw) {
      return
    }

    this.restore(JSON.parse(raw) as StoreSnapshot)
  }
}

export function loadStoreFromEnv(env: NodeJS.ProcessEnv = process.env): InMemoryStore | FileBackedStore {
  const filePath = env.EXECUTION_STORE_PATH?.trim()
  return filePath ? new FileBackedStore(filePath) : new InMemoryStore()
}

function mapExecutionStatusToJobStatus(status: ExecutionStatus['status']): ExecutionJobStatus {
  switch (status) {
    case 'prepared':
      return 'prepared'
    case 'submitted':
      return 'submitted'
    case 'pending':
      return 'pending'
    case 'confirmed':
      return 'confirmed'
    case 'failed':
      return 'failed'
    default:
      return 'planned'
  }
}

function isZeroHash(txHash: string | undefined): boolean {
  return /^0x0{64}$/i.test(txHash ?? '')
}

function normalizeTxHash(txHash: string | undefined): string | undefined {
  return txHash?.toLowerCase()
}
