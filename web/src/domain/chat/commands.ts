export interface ThresholdDto {
  unit: 'tokens' | 'percent'
  value: number
}

export interface CommandConfigDto {
  warn?: ThresholdDto
  auto?: ThresholdDto
  min_context_limit?: number
  safety_margin?: number
}

export interface CommandConfigDataDto {
  warn: ThresholdDto
  auto: ThresholdDto
  minContextLimit: number
}
