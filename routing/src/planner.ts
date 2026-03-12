import type { PlannedRoute, RouteQuote, TradeIntent } from '@mde/domain'
import { createLogger } from '@mde/monitoring'
import type { ProtocolAdapter } from '@mde/protocols'
import { addBps, compareAmounts, safeBigInt, subtractAmounts } from '@mde/protocols'
import { BridgeRouter } from '@mde/bridges'
import { scoreRoute } from './scoring.js'

export type PlannerDependencies = {
  adapters: Record<string, ProtocolAdapter>
  bridgeRouter: BridgeRouter
}

const FLASH_PROTOCOLS = new Set(['aave_v3', 'dydx'])
const SWAP_PROTOCOLS = new Set(['uniswap_v3', 'pancakeswap', 'sushiswap', 'curve'])

export class ExecutionPlanner {
  private readonly logger = createLogger('planner')

  constructor(private readonly deps: PlannerDependencies) {}

  async plan(intent: TradeIntent): Promise<PlannedRoute[]> {
    const atomicRoutes = await this.buildAtomicRoutes(intent)
    if (atomicRoutes.length > 0) {
      this.logger.info('planned_atomic_routes', { intentId: intent.intentId, count: atomicRoutes.length })
      return atomicRoutes.sort((a, b) => b.score - a.score)
    }

    if (intent.requireFlashLiquidity) {
      const flashEnvelopes = await this.buildStandaloneFlashRoutes(intent)
      if (flashEnvelopes.length > 0) {
        this.logger.info('planned_flash_envelopes', { intentId: intent.intentId, count: flashEnvelopes.length })
        return flashEnvelopes.sort((a, b) => b.score - a.score)
      }

      this.logger.warn('no_supported_flash_routes', {
        intentId: intent.intentId,
        sourceChain: intent.sourceChain,
      })
      return []
    }

    const candidates: PlannedRoute[] = []

    for (const protocolKey of intent.allowedProtocols) {
      const adapter = this.deps.adapters[protocolKey]
      if (!adapter) continue

      const quotes = await adapter.quote({
        intent,
        candidateProtocols: [],
      })

      for (const quote of quotes) {
        candidates.push(await this.quoteToRoute(intent, quote))
      }
    }

    this.logger.info('planned_routes', { intentId: intent.intentId, count: candidates.length })
    return candidates.sort((a, b) => b.score - a.score)
  }

  private async buildAtomicRoutes(intent: TradeIntent): Promise<PlannedRoute[]> {
    if (!intent.requireFlashLiquidity) return []
    if (intent.destinationChain && intent.destinationChain !== intent.sourceChain) return []

    const cycleAssets = this.readCycleAssets(intent)
    if (!cycleAssets || cycleAssets[0] !== cycleAssets[2]) return []

    const [borrowAsset, pivotAsset, repayAsset] = cycleAssets
    const flashQuotes = await this.quoteFlashProtocols(intent, borrowAsset, repayAsset)
    if (flashQuotes.length === 0) return []

    const routes: PlannedRoute[] = []
    for (const flashQuote of flashQuotes.slice(0, 2)) {
      const forwardQuotes = await this.quoteSwapProtocols(intent, borrowAsset, pivotAsset, intent.amountIn ?? '0')
      for (const forwardQuote of forwardQuotes.slice(0, 3)) {
        const reverseQuotes = await this.quoteSwapProtocols(intent, pivotAsset, repayAsset, forwardQuote.estimatedAmountOut)
        for (const reverseQuote of reverseQuotes.filter((quote) => this.isDistinctLeg(forwardQuote, reverseQuote)).slice(0, 3)) {
          routes.push(this.buildAtomicCycleRoute(intent, flashQuote, forwardQuote, reverseQuote, cycleAssets))
        }
      }
    }

    return routes.sort((a, b) => b.score - a.score)
  }

  private async buildStandaloneFlashRoutes(intent: TradeIntent): Promise<PlannedRoute[]> {
    if (!intent.requireFlashLiquidity) return []
    if (intent.destinationChain && intent.destinationChain !== intent.sourceChain) return []

    const borrowAsset = intent.inputAssets[0] ?? intent.outputAssets[0] ?? 'UNKNOWN'
    const flashQuotes = await this.quoteFlashProtocols(intent, borrowAsset, borrowAsset)
    return flashQuotes.map((quote) => this.flashEnvelopeQuoteToRoute(intent, quote))
  }

  private buildAtomicCycleRoute(
    intent: TradeIntent,
    flashQuote: RouteQuote,
    forwardQuote: RouteQuote,
    reverseQuote: RouteQuote,
    cycleAssets: [string, string, string]
  ): PlannedRoute {
    const [borrowAsset, pivotAsset, repayAsset] = cycleAssets
    const amountIn = intent.amountIn ?? '0'
    const flashFeeBps = flashQuote.flashFeeBps ?? 0
    const amountOwed = addBps(amountIn, flashFeeBps)
    const expectedFinalAmount = reverseQuote.estimatedAmountOut
    const expectedNetAfterRepay = subtractAmounts(expectedFinalAmount, amountOwed)
    const hasRepaymentCoverage = compareAmounts(expectedFinalAmount, amountOwed) >= 0
    const pnlBps = this.relativeBps(expectedNetAfterRepay, amountIn)

    const forwardMeta = (forwardQuote.metadata ?? {}) as Record<string, unknown>
    const reverseMeta = (reverseQuote.metadata ?? {}) as Record<string, unknown>
    const flashMeta = (flashQuote.metadata ?? {}) as Record<string, unknown>

    const totalSwapFeeBps = (forwardQuote.swapFeeBps ?? 0) + (reverseQuote.swapFeeBps ?? 0)
    const totalSlippageBps = (forwardQuote.slippageBps ?? 0) + (reverseQuote.slippageBps ?? 0)
    const totalEstimatedGas = Number(flashQuote.estimatedGas) + Number(forwardQuote.estimatedGas) + Number(reverseQuote.estimatedGas)
    const liquidityScore = Math.min(forwardQuote.liquidityScore ?? 0.5, reverseQuote.liquidityScore ?? 0.5)
    const confidence = Math.min(flashQuote.confidence ?? 0.5, forwardQuote.confidence ?? 0.5, reverseQuote.confidence ?? 0.5)
    const quoteModels = [
      String(flashMeta.quoteModel ?? ''),
      String(forwardMeta.quoteModel ?? ''),
      String(reverseMeta.quoteModel ?? ''),
    ].filter(Boolean)
    const discoveryModes = [
      String(flashMeta.discoveryMode ?? ''),
      String(forwardMeta.discoveryMode ?? ''),
      String(reverseMeta.discoveryMode ?? ''),
    ].filter(Boolean)
    const stateTimestamps = [
      Number(flashMeta.stateTimestampMs ?? 0),
      Number(forwardMeta.stateTimestampMs ?? 0),
      Number(reverseMeta.stateTimestampMs ?? 0),
    ].filter((value) => Number.isFinite(value) && value > 0)

    const score = scoreRoute({
      expectedPnlUsd: pnlBps / 10,
      flashFeeUsd: flashFeeBps / 100,
      swapFeeUsd: totalSwapFeeBps / 100,
      bridgeFeeUsd: 0,
      gasUsd: totalEstimatedGas * 0.000001,
      slippageRisk: totalSlippageBps / 10000,
      liquidityDepth: liquidityScore,
      repaymentCertainty: hasRepaymentCoverage ? 0.98 : 0.2,
      bridgeCompletionConfidence: 1,
    })

    const warnings = this.uniqueStrings([
      ...this.metadataWarnings(flashMeta),
      ...this.metadataWarnings(forwardMeta),
      ...this.metadataWarnings(reverseMeta),
      ...(!hasRepaymentCoverage ? ['Simulated cycle does not fully cover flash principal plus premium'] : []),
      ...(
        quoteModels.some((model) => model.startsWith('seeded_') || model.startsWith('deployment_seed'))
          ? ['Route combines at least one seeded quote model; enable RPC for fresher state']
          : []
      ),
    ])

    const protocolKeys = this.uniqueStrings([flashQuote.protocolKey, forwardQuote.protocolKey, reverseQuote.protocolKey])
    const flashProviderAddress = String(
      flashMeta.flashProviderAddress ?? flashMeta.aavePool ?? flashMeta.soloMarginAddress ?? ''
    )
    const borrowAssetAddress = String(flashMeta.borrowAssetAddress ?? borrowAsset)
    const repayAssetAddress = String(flashMeta.borrowAssetAddress ?? borrowAssetAddress)

    return {
      routeId: `${intent.intentId}:${flashQuote.protocolKey}:atomic:${intent.sourceChain}:${forwardQuote.protocolKey}:${String(forwardMeta.poolAddress ?? 'forward')}:${reverseQuote.protocolKey}:${String(reverseMeta.poolAddress ?? 'reverse')}`,
      intentId: intent.intentId,
      sourceChain: intent.sourceChain,
      protocolKeys,
      executionModel: 'same_chain_atomic',
      steps: [
        {
          stepId: `${intent.intentId}:flash`,
          type: 'flash_borrow',
          chainKey: intent.sourceChain,
          protocolKey: flashQuote.protocolKey,
          action: String(flashMeta.routeAction ?? 'flash_borrow'),
          requiresAtomic: true,
          params: {
            borrowAsset,
            borrowAssetAddress,
            amountIn,
            flashProviderAddress,
            callbackType: String(flashMeta.callbackType ?? ''),
            aavePool: String(flashMeta.aavePool ?? ''),
            soloMarginAddress: String(flashMeta.soloMarginAddress ?? ''),
          },
        },
        {
          stepId: `${intent.intentId}:swap:1`,
          type: 'swap',
          chainKey: intent.sourceChain,
          protocolKey: forwardQuote.protocolKey,
          action: String(forwardMeta.routeAction ?? 'swap'),
          requiresAtomic: true,
          params: {
            tokenIn: borrowAsset,
            tokenOut: pivotAsset,
            amountIn,
            estimatedAmountOut: forwardQuote.estimatedAmountOut,
            minAmountOut: forwardQuote.estimatedAmountOut,
            feeTier: Number(forwardMeta.feeTier ?? 0),
            poolAddress: String(forwardMeta.poolAddress ?? ''),
            routerAddress: String(forwardMeta.routerAddress ?? ''),
            slippageBps: forwardQuote.slippageBps ?? 0,
            edgeBps: Number(forwardMeta.edgeBps ?? 0),
          },
        },
        {
          stepId: `${intent.intentId}:swap:2`,
          type: 'swap',
          chainKey: intent.sourceChain,
          protocolKey: reverseQuote.protocolKey,
          action: String(reverseMeta.routeAction ?? 'swap'),
          requiresAtomic: true,
          params: {
            tokenIn: pivotAsset,
            tokenOut: repayAsset,
            amountIn: forwardQuote.estimatedAmountOut,
            estimatedAmountOut: reverseQuote.estimatedAmountOut,
            minAmountOut: reverseQuote.estimatedAmountOut,
            feeTier: Number(reverseMeta.feeTier ?? 0),
            poolAddress: String(reverseMeta.poolAddress ?? ''),
            routerAddress: String(reverseMeta.routerAddress ?? ''),
            slippageBps: reverseQuote.slippageBps ?? 0,
            edgeBps: Number(reverseMeta.edgeBps ?? 0),
          },
        },
        {
          stepId: `${intent.intentId}:repay`,
          type: 'repay',
          chainKey: intent.sourceChain,
          protocolKey: flashQuote.protocolKey,
          action: String(flashMeta.repayAction ?? 'repay_flash_loan'),
          requiresAtomic: true,
          params: {
            repayAsset,
            repayAssetAddress,
            amountOwed,
            expectedFinalAmount,
          },
        },
      ],
      estimatedPnlUsd: pnlBps / 10,
      estimatedGasUsd: totalEstimatedGas * 0.000001,
      score,
      warnings,
      metadata: {
        quoteModel: quoteModels.length > 0 ? quoteModels.join('|') : 'seeded_atomic_cycle',
        discoveryModes: discoveryModes.join('|'),
        stateTimestampMs: stateTimestamps.length > 0 ? Math.min(...stateTimestamps) : undefined,
        deadlineMs: intent.deadlineMs,
        maxSlippageBps: intent.maxSlippageBps,
        cycleAssets,
        borrowAsset,
        borrowAssetAddress,
        pivotAsset,
        repayAsset,
        repayAssetAddress,
        borrowAmount: amountIn,
        amountOwed,
        expectedFinalAmount,
        expectedNetAfterRepay,
        flashSourceProtocol: flashQuote.protocolKey,
        flashProviderAddress,
        flashMethod: String(flashMeta.flashMethod ?? 'flashLoanSimple'),
        callbackType: String(flashMeta.callbackType ?? ''),
        aavePool: String(flashMeta.aavePool ?? ''),
        reserveState: flashMeta.reserveState,
        receiverAddress: String(flashMeta.receiverAddress ?? '{{AAVE_RECEIVER}}'),
        soloMarginAddress: String(flashMeta.soloMarginAddress ?? ''),
        marketId: flashMeta.marketId,
        routeExecutorAddress: String(
          flashMeta.routeExecutorAddress ?? forwardMeta.routeExecutorAddress ?? reverseMeta.routeExecutorAddress ?? '{{ROUTE_EXECUTOR}}'
        ),
        swapLiquidityScore: liquidityScore,
        confidence,
        pnlBps,
        forwardPool: String(forwardMeta.poolAddress ?? ''),
        reversePool: String(reverseMeta.poolAddress ?? ''),
        forwardProtocol: forwardQuote.protocolKey,
        reverseProtocol: reverseQuote.protocolKey,
      },
    }
  }

  private flashEnvelopeQuoteToRoute(intent: TradeIntent, quote: RouteQuote): PlannedRoute {
    const metadata = (quote.metadata ?? {}) as Record<string, unknown>
    const borrowAsset = String(metadata.borrowAsset ?? intent.inputAssets[0] ?? intent.outputAssets[0] ?? 'UNKNOWN')
    const borrowAssetAddress = String(metadata.borrowAssetAddress ?? borrowAsset)
    const borrowAmount = String(metadata.borrowAmount ?? intent.amountIn ?? '0')
    const amountOwed = addBps(borrowAmount, quote.flashFeeBps ?? 0)
    const score = scoreRoute({
      expectedPnlUsd: 0,
      flashFeeUsd: (quote.flashFeeBps ?? 0) / 100,
      swapFeeUsd: 0,
      bridgeFeeUsd: 0,
      gasUsd: Number(quote.estimatedGas) * 0.000001,
      slippageRisk: 0,
      liquidityDepth: quote.liquidityScore ?? 0.5,
      repaymentCertainty: quote.confidence ?? 0.5,
      bridgeCompletionConfidence: 1,
    })

    return {
      routeId: `${quote.routeId}:flash_envelope`,
      intentId: intent.intentId,
      sourceChain: intent.sourceChain,
      protocolKeys: [quote.protocolKey],
      executionModel: 'same_chain_atomic',
      steps: [
        {
          stepId: `${quote.routeId}:flash`,
          type: 'flash_borrow',
          chainKey: intent.sourceChain,
          protocolKey: quote.protocolKey,
          action: String(metadata.routeAction ?? 'flash_borrow'),
          requiresAtomic: true,
          params: {
            borrowAsset,
            borrowAssetAddress,
            amountIn: borrowAmount,
            callbackType: String(metadata.callbackType ?? ''),
            flashProviderAddress: String(metadata.flashProviderAddress ?? ''),
          },
        },
        {
          stepId: `${quote.routeId}:repay`,
          type: 'repay',
          chainKey: intent.sourceChain,
          protocolKey: quote.protocolKey,
          action: String(metadata.repayAction ?? 'repay_flash_loan'),
          requiresAtomic: true,
          params: {
            repayAsset: borrowAsset,
            repayAssetAddress: borrowAssetAddress,
            amountOwed,
            expectedFinalAmount: amountOwed,
          },
        },
      ],
      estimatedPnlUsd: 0,
      estimatedGasUsd: Number(quote.estimatedGas) * 0.000001,
      score,
      warnings: this.uniqueStrings([
        ...this.metadataWarnings(metadata),
        'Standalone flash envelope route contains no swap legs; compose downstream steps before live execution',
      ]),
      metadata: {
        ...(quote.metadata ?? {}),
        deadlineMs: intent.deadlineMs,
        maxSlippageBps: intent.maxSlippageBps,
        borrowAsset,
        borrowAssetAddress,
        borrowAmount,
        amountOwed,
        expectedFinalAmount: amountOwed,
        expectedNetAfterRepay: '0',
        swapLiquidityScore: quote.liquidityScore ?? 0.5,
        confidence: quote.confidence ?? 0.5,
        flashSourceProtocol: quote.protocolKey,
        flashProviderAddress: String(metadata.flashProviderAddress ?? ''),
        quoteModel: quote.metadata?.quoteModel ?? 'flash_envelope_quote',
      },
    }
  }

  private async quoteToRoute(intent: TradeIntent, quote: RouteQuote): Promise<PlannedRoute> {
    if (quote.metadata?.routeTemplate === 'flash_envelope') {
      return this.flashEnvelopeQuoteToRoute(intent, quote)
    }

    const isCrossChain = Boolean(intent.destinationChain && intent.destinationChain !== intent.sourceChain)
    const bridgeQuotes = isCrossChain
      ? await this.deps.bridgeRouter.quote({
          sourceChain: intent.sourceChain,
          destinationChain: intent.destinationChain!,
          sourceAsset: intent.inputAssets[0] ?? 'UNKNOWN',
          destinationAsset: intent.outputAssets[0] ?? 'UNKNOWN',
          amountIn: intent.amountIn ?? '0',
          allowedProviders: intent.allowedBridgeProviders,
        })
      : []

    const bridgeQuote = bridgeQuotes[0]
    const score = scoreRoute({
      expectedPnlUsd: (quote.liquidityScore ?? 0.5) * 20,
      flashFeeUsd: (quote.flashFeeBps ?? 0) / 100,
      swapFeeUsd: (quote.swapFeeBps ?? 0) / 100,
      bridgeFeeUsd: (quote.bridgeFeeBps ?? 0) / 100,
      gasUsd: Number(quote.estimatedGas) * 0.000001,
      slippageRisk: (quote.slippageBps ?? 10) / 10000,
      liquidityDepth: quote.liquidityScore ?? 0.5,
      repaymentCertainty: quote.confidence ?? 0.5,
      bridgeCompletionConfidence: bridgeQuote ? 0.6 : 1,
    })

    const action = String(quote.metadata?.routeAction ?? 'swap')

    return {
      routeId: quote.routeId,
      intentId: intent.intentId,
      sourceChain: intent.sourceChain,
      destinationChain: intent.destinationChain,
      protocolKeys: [quote.protocolKey, ...(bridgeQuote ? [bridgeQuote.provider] : [])],
      executionModel: isCrossChain ? 'cross_chain_staged' : 'same_chain_atomic',
      steps: [
        {
          stepId: `${quote.routeId}:step:1`,
          type: 'swap',
          chainKey: intent.sourceChain,
          protocolKey: quote.protocolKey,
          action,
          requiresAtomic: !isCrossChain,
          params: {
            tokenIn: intent.inputAssets[0] ?? 'UNKNOWN',
            tokenOut: intent.outputAssets[0] ?? 'UNKNOWN',
            amountIn: intent.amountIn ?? '0',
            estimatedAmountOut: quote.estimatedAmountOut,
            minAmountOut: quote.estimatedAmountOut,
            feeTier: Number(quote.metadata?.feeTier ?? 0),
            poolAddress: String(quote.metadata?.poolAddress ?? ''),
            routerAddress: String(quote.metadata?.routerAddress ?? ''),
            slippageBps: quote.slippageBps ?? 0,
          },
        },
        ...(bridgeQuote
          ? [{
              stepId: `${quote.routeId}:bridge`,
              type: 'bridge' as const,
              chainKey: intent.sourceChain,
              protocolKey: bridgeQuote.provider,
              action: 'bridge_transfer',
              requiresAtomic: false,
              params: {
                sourceChain: bridgeQuote.sourceChain,
                destinationChain: bridgeQuote.destinationChain,
                provider: bridgeQuote.provider,
                estimatedTimeSec: bridgeQuote.estimatedTimeSec,
              },
            }]
          : []),
      ],
      estimatedPnlUsd: (quote.liquidityScore ?? 0.5) * 20,
      estimatedGasUsd: Number(quote.estimatedGas) * 0.000001,
      estimatedBridgeTimeSec: bridgeQuote?.estimatedTimeSec,
      score,
      warnings: bridgeQuote?.warnings ?? [],
      metadata: {
        ...(quote.metadata ?? {}),
        deadlineMs: intent.deadlineMs,
        maxSlippageBps: intent.maxSlippageBps,
        quoteModel: quote.metadata?.quoteModel ?? 'single_protocol_quote',
        liquidityScore: quote.liquidityScore,
        confidence: quote.confidence,
      },
    }
  }

  private async quoteFlashProtocols(intent: TradeIntent, borrowAsset: string, repayAsset: string): Promise<RouteQuote[]> {
    const quotes: RouteQuote[] = []
    for (const protocolKey of intent.allowedProtocols.filter((key) => FLASH_PROTOCOLS.has(key))) {
      const adapter = this.deps.adapters[protocolKey]
      if (!adapter) continue
      try {
        const next = await adapter.quote({
          intent: {
            ...intent,
            inputAssets: [borrowAsset],
            outputAssets: [repayAsset],
          },
          candidateProtocols: [],
        })
        quotes.push(...next)
      } catch {
        continue
      }
    }
    return quotes.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  }

  private async quoteSwapProtocols(intent: TradeIntent, tokenIn: string, tokenOut: string, amountIn: string): Promise<RouteQuote[]> {
    const quotes: RouteQuote[] = []
    for (const protocolKey of intent.allowedProtocols.filter((key) => SWAP_PROTOCOLS.has(key))) {
      const adapter = this.deps.adapters[protocolKey]
      if (!adapter) continue
      try {
        const next = await adapter.quote({
          intent: {
            ...intent,
            requireFlashLiquidity: false,
            inputAssets: [tokenIn],
            outputAssets: [tokenOut],
            amountIn,
          },
          candidateProtocols: [],
        })
        quotes.push(...next)
      } catch {
        continue
      }
    }
    return quotes.sort((a, b) => (b.liquidityScore ?? 0) - (a.liquidityScore ?? 0))
  }

  private readCycleAssets(intent: TradeIntent): [string, string, string] | undefined {
    const raw = intent.metadata?.cycleAssets
    if (!Array.isArray(raw)) return undefined
    const cycleAssets = raw.filter((value): value is string => typeof value === 'string')
    if (cycleAssets.length !== 3) return undefined
    return [cycleAssets[0], cycleAssets[1], cycleAssets[2]]
  }

  private metadataWarnings(metadata: Record<string, unknown>): string[] {
    return Array.isArray(metadata.warnings)
      ? metadata.warnings.filter((value): value is string => typeof value === 'string')
      : []
  }

  private isDistinctLeg(left: RouteQuote, right: RouteQuote): boolean {
    if (left.routeId !== right.routeId) return true
    return left.protocolKey !== right.protocolKey
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
  }

  private relativeBps(delta: string, baseAmount: string): number {
    const denominator = safeBigInt(baseAmount)
    if (denominator === 0n) return 0
    return Number((safeBigInt(delta) * 10_000n) / denominator)
  }
}
