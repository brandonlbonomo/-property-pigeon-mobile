export interface MonthPoint {
  label: string;       // e.g. "Jan", "Feb"
  value: number;
  isActual: boolean;   // true = real data, false = projected
  isCurrent: boolean;  // true = current month
  month: number;       // 0-11
  year: number;
}

export interface QuarterPoint {
  label: string;       // e.g. "Q1"
  value: number;
  isActual: boolean;
  isCurrent: boolean;
}

export interface AnnualPoint {
  label: string;       // e.g. "2025"
  value: number;
  isActual: boolean;
  isCurrent: boolean;
}

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const STYLE_FACTOR: Record<string, number> = {
  conservative: 0.5,
  normal: 1.0,
  bullish: 1.5,
};

/**
 * Compute month-over-month growth rate from two data points, capped at +/- 15%.
 */
function clampedGrowthRate(current: number, prior: number, style: string): number {
  if (prior === 0) return 0;
  const raw = (current - prior) / Math.abs(prior);
  const capped = Math.max(-0.15, Math.min(0.15, raw));
  const factor = STYLE_FACTOR[style] ?? 1;
  return capped * factor;
}

/**
 * Project a value N months forward (positive) or backward (negative) from the current value.
 */
function projectValue(currentValue: number, rate: number, monthsOffset: number): number {
  if (rate === 0 || monthsOffset === 0) return currentValue;
  if (monthsOffset > 0) return currentValue * Math.pow(1 + rate, monthsOffset);
  return currentValue / Math.pow(1 + rate, Math.abs(monthsOffset));
}

/**
 * Generate 12 monthly points for a specific target year.
 * Actual data only exists for current month and prior month; everything else is projected.
 */
export function generateYearTimeline(
  currentValue: number,
  priorValue: number,
  projectionStyle: string = 'normal',
  targetYear: number,
): MonthPoint[] {
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();
  const priorMonth = curMonth === 0 ? 11 : curMonth - 1;
  const priorYear = curMonth === 0 ? curYear - 1 : curYear;

  const rate = clampedGrowthRate(currentValue, priorValue, projectionStyle);
  const points: MonthPoint[] = [];

  for (let m = 0; m < 12; m++) {
    // How many months is this from the current month?
    const offset = (targetYear - curYear) * 12 + (m - curMonth);

    const isCurrentMonth = targetYear === curYear && m === curMonth;
    const isPriorMonth = targetYear === priorYear && m === priorMonth;

    let value: number;
    if (isCurrentMonth) {
      value = currentValue;
    } else if (isPriorMonth) {
      value = priorValue;
    } else {
      value = projectValue(currentValue, rate, offset);
    }

    points.push({
      label: MONTH_ABBR[m],
      value: Math.max(0, value),
      isActual: isCurrentMonth || isPriorMonth,
      isCurrent: isCurrentMonth,
      month: m,
      year: targetYear,
    });
  }

  return points;
}

/**
 * Generate a 12-month timeline centered on the current month:
 *   6 months back → prior month (actual) → current month (actual) → 4 months forward
 */
export function generateMonthlyTimeline(
  currentValue: number,
  priorValue: number,
  projectionStyle: string = 'normal',
): MonthPoint[] {
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();
  const priorMonth = curMonth === 0 ? 11 : curMonth - 1;
  const priorYear = curMonth === 0 ? curYear - 1 : curYear;

  const rate = clampedGrowthRate(currentValue, priorValue, projectionStyle);
  const points: MonthPoint[] = [];

  // Build backwards from prior month (6 projected months before prior)
  let val = priorValue;
  const backPoints: MonthPoint[] = [];
  for (let i = 1; i <= 6; i++) {
    val = rate !== 0 ? val / (1 + rate) : val;
    let mm = priorMonth - i;
    let yy = priorYear;
    while (mm < 0) { mm += 12; yy--; }
    backPoints.unshift({
      label: MONTH_ABBR[mm],
      value: Math.max(0, val),
      isActual: false,
      isCurrent: false,
      month: mm,
      year: yy,
    });
  }

  points.push(...backPoints);

  // Prior month (actual)
  points.push({
    label: MONTH_ABBR[priorMonth],
    value: priorValue,
    isActual: true,
    isCurrent: false,
    month: priorMonth,
    year: priorYear,
  });

  // Current month (actual)
  points.push({
    label: MONTH_ABBR[curMonth],
    value: currentValue,
    isActual: true,
    isCurrent: true,
    month: curMonth,
    year: curYear,
  });

  // Forward projections (4 months)
  val = currentValue;
  for (let i = 1; i <= 4; i++) {
    val = val * (1 + rate);
    const mm = (curMonth + i) % 12;
    const yy = curYear + Math.floor((curMonth + i) / 12);
    points.push({
      label: MONTH_ABBR[mm],
      value: val,
      isActual: false,
      isCurrent: false,
      month: mm,
      year: yy,
    });
  }

  return points;
}

/**
 * Aggregate monthly points into quarters.
 */
export function aggregateToQuarters(months: MonthPoint[]): QuarterPoint[] {
  const byQuarter: Record<string, { values: number[]; hasActual: boolean; hasCurrent: boolean }> = {};

  for (const m of months) {
    const q = Math.floor(m.month / 3) + 1;
    const key = `${m.year}-Q${q}`;
    if (!byQuarter[key]) byQuarter[key] = { values: [], hasActual: false, hasCurrent: false };
    byQuarter[key].values.push(m.value);
    if (m.isActual) byQuarter[key].hasActual = true;
    if (m.isCurrent) byQuarter[key].hasCurrent = true;
  }

  return Object.entries(byQuarter)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, data]) => ({
      label: key.split('-')[1],
      value: data.values.reduce((a, b) => a + b, 0),
      isActual: data.hasActual,
      isCurrent: data.hasCurrent,
    }));
}

/**
 * Aggregate monthly points into annual totals.
 */
export function aggregateToAnnual(months: MonthPoint[]): AnnualPoint[] {
  const byYear: Record<number, { values: number[]; hasActual: boolean; hasCurrent: boolean }> = {};

  for (const m of months) {
    if (!byYear[m.year]) byYear[m.year] = { values: [], hasActual: false, hasCurrent: false };
    byYear[m.year].values.push(m.value);
    if (m.isActual) byYear[m.year].hasActual = true;
    if (m.isCurrent) byYear[m.year].hasCurrent = true;
  }

  return Object.entries(byYear)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([year, data]) => ({
      label: year,
      value: data.values.reduce((a, b) => a + b, 0),
      isActual: data.hasActual,
      isCurrent: data.hasCurrent,
    }));
}

/**
 * Get the list of available years (2020 → current year + 4).
 * Future years beyond current show projections.
 */
export function getAvailableYears(): number[] {
  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = 2024; y <= currentYear + 4; y++) {
    years.push(y);
  }
  return years;
}

// ── 30-Year Projection Engine (shared) ──

export interface YearRow {
  year: number;
  yearOffset: number;
  units: number;
  revenue: number;
  expenses: number;
  netCF: number;
  portfolioValue: number;
  equity: number;
  mortgageBalance: number;
}

export const PROJECTION_VALUE_PER_UNIT = 150000;
export const PROJECTION_LTV = 0.75;
export const PROJECTION_MORTGAGE_RATE = 0.065;

export const STYLE_FACTORS: Record<string, { revGrowth: number; expGrowth: number; appreciation: number }> = {
  conservative: { revGrowth: 0.02, expGrowth: 0.03, appreciation: 0.03 },
  normal:       { revGrowth: 0.04, expGrowth: 0.03, appreciation: 0.04 },
  bullish:      { revGrowth: 0.06, expGrowth: 0.025, appreciation: 0.06 },
};

export function generate30YearProjection(
  startingUnits: number,
  unitsPerYear: number,
  currentRevenue: number,     // monthly
  currentExpenses: number,    // monthly
  projectionStyle: string,
): YearRow[] {
  const curYear = new Date().getFullYear();
  const revenuePerUnit = startingUnits > 0 ? (currentRevenue * 12) / startingUnits : 0;
  const expensePerUnit = startingUnits > 0 ? (currentExpenses * 12) / startingUnits : 0;

  const factors = STYLE_FACTORS[projectionStyle] || STYLE_FACTORS.normal;
  const valuePerUnit = PROJECTION_VALUE_PER_UNIT;
  const ltv = PROJECTION_LTV;
  const mortgageRate = PROJECTION_MORTGAGE_RATE;
  const years: YearRow[] = [];

  for (let i = 0; i <= 30; i += 5) {
    const yearOffset = i;
    const year = curYear + i;
    const units = startingUnits + unitsPerYear * i;

    const revPerUnit = revenuePerUnit * Math.pow(1 + factors.revGrowth, i);
    const expPerUnit = expensePerUnit * Math.pow(1 + factors.expGrowth, i);
    const revenue = units * revPerUnit;
    const expenses = units * expPerUnit;

    const addedUnits = Math.max(0, units - startingUnits);
    const mortgageCost = addedUnits * valuePerUnit * ltv * mortgageRate;
    const netCF = revenue - expenses - mortgageCost;

    const portfolioValue = units * valuePerUnit * Math.pow(1 + factors.appreciation, i);
    const mortgageBalance = addedUnits * valuePerUnit * ltv * Math.max(0, 1 - i * 0.033);
    const equity = portfolioValue - mortgageBalance;

    years.push({ year, yearOffset, units, revenue, expenses, netCF, portfolioValue, equity, mortgageBalance });
  }

  return years;
}
