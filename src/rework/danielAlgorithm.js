import { calculateSimpleRework } from "./simpleReworkModel.js";

export function calculateDaniel(osuText, speedRate = 1, odFlag = null, options = {}) {
  const result = calculateSimpleRework(osuText, speedRate, {
    ...options,
    odFlag,
    scale: 1.04
  });

  if (result && typeof result === "object" && Number(result.columnCount) !== 4) {
    return -3;
  }

  return result;
}
