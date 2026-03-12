import type { BridgeQuote } from '@mde/domain'

export type BridgeRequest = {
  sourceChain: string
  destinationChain: string
  sourceAsset: string
  destinationAsset: string
  amountIn: string
  allowedProviders?: string[]
}

const DEFAULT_BRIDGE_PROVIDERS = ['across', 'stargate', 'layerzero', 'wormhole', 'cbridge', 'debridge', 'meson']

export class BridgeRouter {
  async quote(request: BridgeRequest): Promise<BridgeQuote[]> {
    const providers = request.allowedProviders?.length ? request.allowedProviders : DEFAULT_BRIDGE_PROVIDERS
    return providers.map((provider) => ({
      provider,
      sourceChain: request.sourceChain,
      destinationChain: request.destinationChain,
      sourceAsset: request.sourceAsset,
      destinationAsset: request.destinationAsset,
      amountIn: request.amountIn,
      estimatedAmountOut: request.amountIn,
      estimatedTimeSec: provider === 'across' ? 90 : 300,
      requiresManualRedeem: provider === 'wormhole',
      gasTokenRequired: request.sourceChain === 'solana' ? 'SOL' : 'ETH',
      warnings: provider === 'wormhole' ? ['Manual redeem may be required depending on route settlement'] : [],
    }))
  }

  validate(quote: BridgeQuote, maxTimeSec: number): { valid: boolean; reasons: string[] } {
    const reasons: string[] = []
    if (quote.estimatedTimeSec > maxTimeSec) reasons.push('Bridge settlement exceeds strategy threshold')
    if (quote.requiresManualRedeem) reasons.push('Manual redeem route requires explicit policy approval')
    return { valid: reasons.length === 0, reasons }
  }
}
