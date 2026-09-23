export const GROUP_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bc8f00', '#17becf',
  '#393b79', '#637939', '#8c6d31', '#843c39', '#7b4173',
  '#3182bd', '#31a354', '#756bb1', '#e6550d', '#525252',
] as const

export function groupColor(index: number) {
  const normalized = ((Math.trunc(index) % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length
  return GROUP_COLORS[normalized]
}
