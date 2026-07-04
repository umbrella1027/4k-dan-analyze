export function mapToReformRank(value) {
  if (value < 6) return "低於 Reform 六段";
  if (value < 7) return "Reform 六段";
  if (value < 8) return "Reform 七段";
  if (value < 9) return "Reform 八段";
  if (value < 10) return "Reform 九段";
  if (value < 11) return "Reform 十段";
  return "高於 Reform 十段";
}

export function reformRankNumber(value) {
  if (value < 6) return null;
  if (value >= 11) return 11;
  return Math.floor(value);
}
