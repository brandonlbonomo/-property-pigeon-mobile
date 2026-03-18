import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableWithoutFeedback, LayoutChangeEvent } from 'react-native';
import { Colors, FontSize, Spacing } from '../constants/theme';
import { GlossyBarSvg } from './GlossyBar';
import { ChartTooltip, TooltipData } from './ChartTooltip';

// ── Global tooltip dismiss registry ──
const _dismissCallbacks = new Set<() => void>();
let _lastDismissTime = 0;

/** Call this to dismiss all visible chart tooltips app-wide. */
export function dismissAllChartTooltips() {
  if (_dismissCallbacks.size > 0) _lastDismissTime = Date.now();
  _dismissCallbacks.forEach(fn => fn());
}

export interface BarData {
  label: string;
  value: number;
  isActual: boolean;
  isCurrent: boolean;
  /** Value of the prior bar for delta calculations */
  priorValue?: number;
  /** Label for the prior bar */
  priorLabel?: string;
  /** Year-over-year % change */
  yoyValue?: number;
  /** Month string for drill-down (e.g. '2026-03') */
  month?: string;
  /** Year for drill-down */
  year?: number;
}

interface Props {
  bars: BarData[];
  color: string;
  height?: number;
  showNegative?: boolean;
  isPercent?: boolean;
  onBarTap?: (bar: BarData, index: number) => void;
  onDoubleTap?: (bar: BarData, index: number) => void;
  /** Invert delta coloring (green = decrease, for expenses) */
  invertDelta?: boolean;
}

const BAR_GAP = 2;
const LABEL_HEIGHT = 20;
const DOT_HEIGHT = 10;

export function BarChart({
  bars,
  color,
  height = 120,
  showNegative = false,
  isPercent = false,
  onBarTap,
  onDoubleTap,
  invertDelta,
}: Props) {
  const [chartWidth, setChartWidth] = useState(0);
  const [chartLeft, setChartLeft] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Ref-based tracking: immune to ScrollView dismiss race condition.
  // Stores which bar was last tapped and when, so the second tap
  // always works regardless of tooltip state.
  const lastTapRef = useRef<{ index: number; time: number } | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setChartWidth(e.nativeEvent.layout.width);
    setChartLeft(e.nativeEvent.layout.x);
  }, []);

  // Register dismiss callback when tooltip is visible
  const dismissCb = useCallback(() => {
    setTooltip(null);
    // Don't clear lastTapRef — the ref survives dismiss so the
    // second tap still triggers drill-down.
  }, []);

  useEffect(() => {
    if (tooltip) {
      _dismissCallbacks.add(dismissCb);
      return () => { _dismissCallbacks.delete(dismissCb); };
    }
  }, [!!tooltip, dismissCb]);

  if (!bars.length) return null;

  const maxVal = Math.max(...bars.map(b => Math.abs(b.value)), 1);
  const hasNegative = showNegative && bars.some(b => b.value < 0);

  const positiveHeight = hasNegative ? height / 2 : height;
  const negativeHeight = hasNegative ? height / 2 : 0;
  const totalChartHeight = positiveHeight + negativeHeight;

  // Calculate bar positions for SVG
  const barCount = bars.length;
  const barWidth = barCount > 0 ? Math.max((chartWidth - (barCount - 1) * BAR_GAP) / barCount * 0.7, 6) : 6;
  const colWidth = barCount > 0 ? chartWidth / barCount : 0;

  const svgBars = bars.map((bar, i) => {
    const barH = Math.max((Math.abs(bar.value) / maxVal) * (hasNegative ? height / 2 : height), 2);
    const isNeg = bar.value < 0;
    const centerX = colWidth * i + colWidth / 2 - barWidth / 2;

    let y: number;
    if (hasNegative) {
      if (isNeg) {
        y = positiveHeight; // starts at zero line going down
      } else {
        y = positiveHeight - barH; // grows up from zero line
      }
    } else {
      y = totalChartHeight - barH; // grows up from bottom
    }

    return {
      x: centerX,
      y,
      width: barWidth,
      height: barH,
      isActual: bar.isActual,
      isNegative: isNeg,
    };
  });

  const handleBarTap = (index: number) => {
    const bar = bars[index];
    const now = Date.now();
    const prev = lastTapRef.current;

    // Second tap on same bar within 3s → audit view (drill down).
    // Uses a ref so it works even when ScrollView's onTouchStart
    // dismisses the tooltip before this handler fires.
    if (prev && prev.index === index && now - prev.time < 3000) {
      lastTapRef.current = null;
      setTooltip(null);
      onDoubleTap?.(bar, index);
      return;
    }

    // First tap (or tap on different bar, or timeout) → show total
    lastTapRef.current = { index, time: now };
    const svgBar = svgBars[index];
    if (svgBar) {
      const tooltipData: TooltipData = {
        value: bar.value,
        label: bar.label,
        priorValue: bar.priorValue,
        priorLabel: bar.priorLabel,
        yoyValue: bar.yoyValue,
        isPercent,
        barIndex: index,
        barX: svgBar.x + svgBar.width / 2,
        barY: totalChartHeight - svgBar.y,
        invertDelta,
      };
      setTooltip(tooltipData);
      onBarTap?.(bar, index);
    }
  };

  return (
    <View style={[styles.container, { overflow: 'visible' }]} onLayout={onLayout}>
      <View style={[styles.chartArea, { height: totalChartHeight, paddingTop: 12 }]}>
        {/* SVG glossy bars */}
        {chartWidth > 0 && (
          <GlossyBarSvg
            width={chartWidth}
            height={totalChartHeight}
            bars={svgBars}
          />
        )}

        {/* Zero line for negative charts */}
        {hasNegative && (
          <View style={[styles.zeroLine, { top: positiveHeight }]} />
        )}

        {/* Enlarged invisible tap targets over each bar */}
        <View style={[StyleSheet.absoluteFill, { top: -16, bottom: -16 }]}>
          <View style={styles.tapRow}>
            {bars.map((_, i) => (
              <TouchableWithoutFeedback key={i} onPress={() => handleBarTap(i)}>
                <View style={styles.tapTarget} />
              </TouchableWithoutFeedback>
            ))}
          </View>
        </View>

        {/* Tooltip */}
        {tooltip && (
          <ChartTooltip data={tooltip} chartLeft={chartLeft} />
        )}
      </View>

      {/* Labels + current dot row — per-label tap targets */}
      <View style={styles.labelRow}>
        {bars.map((bar, i) => (
          <TouchableWithoutFeedback key={i} onPress={() => handleBarTap(i)}>
            <View style={styles.labelCol}>
              {bar.isCurrent && <View style={styles.currentDot} />}
              <Text style={styles.label}>{bar.label}</Text>
            </View>
          </TouchableWithoutFeedback>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  chartArea: {
    position: 'relative',
  },
  zeroLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.textDim,
  },
  tapRow: {
    flexDirection: 'row',
    flex: 1,
  },
  tapTarget: {
    flex: 1,
    height: '100%',
  },
  labelRow: {
    flexDirection: 'row',
    marginTop: 14,
    paddingBottom: 4,
  },
  labelCol: {
    flex: 1,
    alignItems: 'center',
  },
  currentDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.primary,
    marginBottom: 1,
  },
  label: {
    fontSize: 9,
    color: Colors.textDim,
    textAlign: 'center',
  },
});
