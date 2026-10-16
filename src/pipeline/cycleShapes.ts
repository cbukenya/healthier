/**
 * How the nightly measures move around the start of a period, on average: the shapes the cycle
 * finder looks for (cycle.ts, startScores).
 *
 * They come from mcPHASES (Lin, Li, Kalani, Truong and Mariakakis; PhysioNet, 2025;
 * doi:10.13026/zx6a-2c81): 42 people who menstruate, each wearing a Fitbit Sense for three months
 * or more, with daily hormone tests that mark each cycle's phases.
 * - **How they were made:** each measure was put in spreads from the person's own 61 nights around
 *   it, then averaged across every labelled period start, from 24 nights before to 10 nights after.
 * - **What they hold:** averages across all 42 people. No one's own nights are in them.
 * - **Sleeping heart rate:** the night's low end, the tenth percentile of the one-minute heart rate
 *   during the main sleep (sleepHrLow.ts), from mcPHASES's minute heart rate lined up with its sleep
 *   logs. The shape of the average over light and deep sleep, Google's non-REM heart rate, is the
 *   same to a match of 0.99, so the finder reads that until the low end covers the nights.
 * - **Scale:** each shape has a mean of zero and a length of one. `size` is how far the measure
 *   moved around a start before that, so the measures that move most count most.
 *
 * Heart rate rises through the second half of a cycle and falls back as a period starts, HRV does
 * the opposite, and temperature and breathing follow heart rate, more faintly.
 */

/** The night each shape begins on, relative to a period's first day. */
export const SHAPE_FROM = -24;

export const SHAPES = {
  sleepHr: {
    size: 2.363,
    shape: [-0.1, -0.187, -0.198, -0.116, -0.181, -0.118, -0.129, -0.059, -0.042, 0.027, 0.031, 0.02, 0.061, 0.062, 0.151, 0.165, 0.168, 0.213, 0.26, 0.351, 0.368, 0.277, 0.266, 0.142, -0.025, -0.065, -0.115, -0.146, -0.146, -0.141, -0.164, -0.166, -0.139, -0.166, -0.157],
  },
  restingHr: {
    size: 1.847,
    shape: [-0.115, -0.209, -0.158, -0.147, -0.151, -0.172, -0.149, -0.137, -0.1, -0.105, 0.019, -0.025, -0.002, 0.097, 0.143, 0.123, 0.209, 0.172, 0.236, 0.325, 0.329, 0.322, 0.273, 0.171, 0.152, 0.015, -0.04, -0.09, -0.082, -0.12, -0.228, -0.172, -0.122, -0.126, -0.139],
  },
  hrv: {
    size: 1.651,
    shape: [0.145, 0.187, 0.213, 0.099, 0.172, 0.042, 0.051, -0.044, -0.015, -0.086, -0.017, -0.008, -0.061, -0.058, -0.144, -0.168, -0.211, -0.186, -0.277, -0.3, -0.349, -0.272, -0.222, -0.147, 0.048, 0.131, 0.123, 0.179, 0.177, 0.253, 0.104, 0.16, 0.174, 0.168, 0.141],
  },
  temp: {
    size: 1.372,
    shape: [-0.083, -0.164, -0.1, -0.177, -0.161, -0.117, -0.133, -0.189, -0.109, -0.139, -0.074, -0.025, 0.051, 0.068, 0.092, 0.143, 0.187, 0.261, 0.256, 0.271, 0.341, 0.253, 0.29, 0.163, 0.131, 0.08, -0.003, -0.099, -0.015, -0.138, -0.105, -0.223, -0.195, -0.261, -0.076],
  },
  breath: {
    size: 1.61,
    shape: [-0.098, -0.132, -0.156, -0.055, -0.207, -0.147, -0.193, -0.172, -0.186, -0.105, -0.089, -0.084, -0.018, -0.017, 0.079, 0.085, 0.139, 0.146, 0.24, 0.326, 0.328, 0.323, 0.286, 0.22, 0.146, 0.151, 0.039, 0.051, -0.013, -0.093, -0.095, -0.171, -0.134, -0.241, -0.151],
  },
} as const;

export type ShapeMeasure = keyof typeof SHAPES;
