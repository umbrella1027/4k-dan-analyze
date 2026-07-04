import { rc4KReform } from "../4k-rc-reform.js";

const fallbackRc = Object.freeze([
  [0, 2, "Intro"],
  [2, 3, "Reform 1"],
  [3, 4, "Reform 2"],
  [4, 5, "Reform 3"],
  [5, 6, "Reform 4"],
  [6, 7, "Reform 5"],
  [7, 8, "Reform 6"],
  [8, 9, "Reform 7"],
  [9, 10, "Reform 8"],
  [10, 11, "Reform 9"],
  [11, 99, "Reform 10+"]
]);

const fallbackLn = Object.freeze([
  [0, 2, "LN Intro"],
  [2, 4, "LN Reform 1"],
  [4, 6, "LN Reform 3"],
  [6, 8, "LN Reform 5"],
  [8, 10, "LN Reform 7"],
  [10, 99, "LN Reform 10+"]
]);

export const DAN_INDEX = Object.freeze({
  4: Object.freeze({
    RC: Object.freeze({ default: rc4KReform }),
    LN: Object.freeze({ default: fallbackLn })
  }),
  6: Object.freeze({
    RC: Object.freeze({ default: fallbackRc }),
    LN: Object.freeze({ default: fallbackLn })
  }),
  7: Object.freeze({
    RC: Object.freeze({ default: fallbackRc }),
    LN: Object.freeze({ default: fallbackLn })
  })
});
