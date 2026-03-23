import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, LayoutChangeEvent } from 'react-native';
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
  /** Projected value — renders a grey background bar behind the actual green bar */
  projectedValue?: number;
}

interface Props {
  bars: BarData[];
  color: string;
  height?: number;
  showNegative?: boolean;
  isPercent?: boolean;
  onBarTap?: (bar: BarData, index: number) => void;
  onDoubleTap?: (bar: BarData, index: number) => void;
  /** Called when tooltip is dismissed (tap outside bar) — reset card to current period */
  onDismiss?: () => void;
  /** Invert delta coloring (green = decrease, for expenses) */
  invertDelta?: boolean;
  /** Optional second set of bars rendered side-by-side (e.g. expenses next to revenue) */
  pairedBars?: BarData[];
  /** Color type for paired bars in GlossyBarSvg ('red' for expenses) */
  pairedColorType?: 'green' | 'red';
  /** Overlay line graph on top of bars (e.g. expenses line over revenue bars) */
  overlayLine?: { data: BarData[]; color: string };
}

const BAR_GAP = 0;
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
  onDismiss,
  invertDelta,
  pairedBars,
  pairedColorType = 'red',
  overlayLine,
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
    onDismiss?.();
    // Don't clear lastTapRef — the ref survives dismiss so the
    // second tap still triggers drill-down.
  }, [onDismiss]);

  useEffect(() => {
    if (tooltip) {
      _dismissCallbacks.add(dismissCb);
      return () => { _dismissCallbacks.delete(dismissCb); };
    }
  }, [!!tooltip, dismissCb]);

  if (!bars.length) return null;

  const hasPaired = pairedBars && pairedBars.length === bars.length;
  const hasOverlay = overlayLine && overlayLine.data.length === bars.length;
  // Bars and paired bars share the same scale; overlay line gets its own scale
  const barValues = [
    ...bars.map(b => Math.max(Math.abs(b.value), Math.abs(b.projectedValue || 0))),
    ...(hasPaired ? pairedBars!.map(b => Math.abs(b.value)) : []),
  ];
  const maxVal = Math.max(...barValues, 1);
  const overlayMaxVal = hasOverlay
    ? Math.max(...overlayLine!.data.map(b => Math.abs(b.value)), 1)
    : 1;
  const hasNegative = showNegative && bars.some(b => b.value < 0);

  const positiveHeight = hasNegative ? height / 2 : height;
  const negativeHeight = hasNegative ? height / 2 : 0;
  const totalChartHeight = positiveHeight + negativeHeight;

  // Calculate bar positions for SVG
  const barCount = bars.length;
  const colWidth = barCount > 0 ? chartWidth / barCount : 0;
  // Inset bars within each column to create visible gaps between months
  // Paired bars need more gap; single/overlay bars can be fatter
  const COL_INSET = hasPaired
    ? Math.max(Math.round(colWidth * 0.30), 4)
    : Math.max(Math.round(colWidth * 0.12), 2);
  const PAIR_GAP = 0;
  const singleBarWidth = Math.max(colWidth - COL_INSET * 2, 6);
  const pairedBarWidth = hasPaired
    ? Math.max(singleBarWidth / 2, 4)
    : singleBarWidth;

  const computeSvgBar = (bar: BarData, i: number, offset: number, colorType?: 'green' | 'red') => {
    const barH = Math.max((Math.abs(bar.value) / maxVal) * (hasNegative ? height / 2 : height) * 0.78, 2);
    const isNeg = bar.value < 0;
    const centerX = colWidth * i + colWidth / 2 - singleBarWidth / 2 + offset;

    let y: number;
    if (hasNegative) {
      y = isNeg ? positiveHeight : positiveHeight - barH;
    } else {
      y = totalChartHeight - barH;
    }

    return {
      x: centerX,
      y,
      width: pairedBarWidth,
      height: barH,
      isActual: bar.isActual,
      isNegative: isNeg,
      colorType,
    };
  };

  const svgBars = hasPaired
    ? [
        ...bars.map((bar, i) => computeSvgBar(bar, i, 0, 'green')),
        ...pairedBars!.map((bar, i) => computeSvgBar(bar, i, pairedBarWidth + PAIR_GAP, pairedColorType)),
      ]
    : bars.map((bar, i) => computeSvgBar(bar, i, 0));

  // Compute projection background bars (grey bars behind the actual green ones)
  const projBgBars = bars.map((bar, i) => {
    if (!bar.projectedValue || bar.projectedValue <= 0) return null;
    const projH = Math.max((bar.projectedValue / maxVal) * (hasNegative ? height / 2 : height) * 0.78, 2);
    const centerX = colWidth * i + colWidth / 2 - singleBarWidth / 2;
    return {
      x: centerX,
      y: totalChartHeight - projH,
      width: singleBarWidth,
      height: projH,
    };
  });

  // Compute overlay line points (own scale, centered on each column)
  const svgOverlayLine = hasOverlay && chartWidth > 0 ? {
    points: overlayLine!.data.map((bar, i) => {
      const val = Math.abs(bar.value);
      // Use 85% of chart height max so line doesn't touch top edge
      const py = totalChartHeight - (val / overlayMaxVal) * totalChartHeight * 0.85;
      return { x: colWidth * i + colWidth / 2, y: Math.max(py, 2) };
    }),
    color: overlayLine!.color,
  } : undefined;

  // Single tap → show tooltip + update card values
  const handleBarTap = (index: number) => {
    const bar = bars[index];
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
        barX: colWidth * index + colWidth / 2,
        barY: totalChartHeight - svgBar.y,
        invertDelta,
      };
      setTooltip(tooltipData);
      onBarTap?.(bar, index);
    }
  };

  // Long press → audit drill-down
  const handleBarLongPress = (index: number) => {
    const bar = bars[index];
    setTooltip(null);
    onDoubleTap?.(bar, index);
  };

  return (
    <View style={[styles.container, { overflow: 'visible' }]} onLayout={onLayout}>
      <View style={[styles.chartArea, { height: totalChartHeight, paddingTop: 4 }]}>
        {/* SVG glossy bars */}
        {chartWidth > 0 && (
          <GlossyBarSvg
            width={chartWidth}
            height={totalChartHeight}
            bars={svgBars}
            projectionBars={projBgBars}
            overlayLine={svgOverlayLine}
          />
        )}

        {/* Zero line for negative charts */}
        {hasNegative && (
          <View style={[styles.zeroLine, { top: positiveHeight }]} />
        )}

        {/* Tap targets over each column: tap = tooltip, long-press = audit */}
        <View style={styles.tapOverlay}>
          <View style={styles.tapRow}>
            {bars.map((_, i) => (
              <Pressable
                key={i}
                onPress={() => handleBarTap(i)}
                onLongPress={() => handleBarLongPress(i)}
                delayLongPress={350}
                style={styles.tapTarget}
                hitSlop={{ top: 60, bottom: 16, left: 6, right: 6 }}
              />
            ))}
          </View>
        </View>

        {/* Tooltip */}
        {tooltip && (
          <ChartTooltip data={tooltip} chartLeft={chartLeft} />
        )}
      </View>

      {/* Labels + current dot row */}
      <View style={styles.labelRow}>
        {bars.map((bar, i) => (
          <Pressable
            key={i}
            onPress={() => handleBarTap(i)}
            onLongPress={() => handleBarLongPress(i)}
            delayLongPress={350}
            style={styles.labelCol}
          >
            {bar.isCurrent && <View style={styles.currentDot} />}
            <Text style={styles.label}>{bar.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 2,
    paddingBottom: 0,
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
  tapOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
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
    marginTop: 6,
    paddingBottom: 2,
  },
  labelCol: {
    flex: 1,
    alignItems: 'center',
  },
  currentDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.green,
    marginBottom: 1,
  },
  label: {
    fontSize: 9,
    color: Colors.textDim,
    textAlign: 'center',
  },
});
