import { calculateSimpleRework } from "./simpleReworkModel.js";

export function calculate(osuText, speedRate = 1, odFlag = null, cvtFlag = null, options = {}) {
  return calculateSimpleRework(osuText, speedRate, {
    ...options,
    odFlag,
    cvtFlag,
    scale: 0.96
  });
}
