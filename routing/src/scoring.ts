export type RouteScoreInput = {
  expectedPnlUsd: number
  flashFeeUsd: number
  swapFeeUsd: number
  bridgeFeeUsd: number
  gasUsd: number
  slippageRisk: number
  liquidityDepth: number
  repaymentCertainty: number
  bridgeCompletionConfidence: number
}

export const DEFAULT_ROUTE_SCORE_WEIGHTS = {
  expectedPnlUsd: 1.0,
  flashFeeUsd: -1.0,
  swapFeeUsd: -1.0,
  bridgeFeeUsd: -1.0,
  gasUsd: -1.0,
  slippageRisk: -50,
  liquidityDepth: 25,
  repaymentCertainty: 40,
  bridgeCompletionConfidence: 20,
}

export function scoreRoute(input: RouteScoreInput): number {
  const w = DEFAULT_ROUTE_SCORE_WEIGHTS
  return (
    input.expectedPnlUsd * w.expectedPnlUsd +
    input.flashFeeUsd * w.flashFeeUsd +
    input.swapFeeUsd * w.swapFeeUsd +
    input.bridgeFeeUsd * w.bridgeFeeUsd +
    input.gasUsd * w.gasUsd +
    input.slippageRisk * w.slippageRisk +
    input.liquidityDepth * w.liquidityDepth +
    input.repaymentCertainty * w.repaymentCertainty +
    input.bridgeCompletionConfidence * w.bridgeCompletionConfidence
  )
}
