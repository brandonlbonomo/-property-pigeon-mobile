import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Platform, Dimensions, Animated } from 'react-native';
import { Colors, FontSize, Radius, Spacing } from '../constants/theme';
import { fmt$ } from '../utils/format';

const SCREEN_W = Dimensions.get('window').width;
const TOOLTIP_W = 100;

export interface TooltipData {
  value: number;
  label: string;
  priorValue?: number;
  priorLabel?: string;
  yoyValue?: number;
  isPercent?: boolean;
  barIndex: number;
  barX: number;
  barY: number;
  invertDelta?: boolean;
}

interface Props {
  data: TooltipData;
  chartLeft: number;
}

export function ChartTooltip({ data, chartLeft }: Props) {
  const { value, priorValue, yoyValue, isPercent, invertDelta } = data;

  // Entrance animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    fadeAnim.setValue(0);
    scaleAnim.setValue(0.9);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, tension: 100, friction: 12, useNativeDriver: true }),
    ]).start();
  }, [data.barIndex]);

  // Delta vs prior bar
  const deltaPct = priorValue != null && priorValue !== 0
    ? ((value - priorValue) / Math.abs(priorValue)) * 100
    : null;

  // Delta coloring
  const deltaColor = (d: number) => {
    if (invertDelta) return d <= 0 ? Colors.green : Colors.red;
    return d >= 0 ? Colors.green : Colors.red;
  };

  // Only show delta if there's data
  const hasDelta = deltaPct != null && isFinite(deltaPct);
  const hasYoY = yoyValue != null && isFinite(yoyValue) && yoyValue !== 0;

  // Clamp position
  const rawLeft = data.barX - TOOLTIP_W / 2;
  const clampedLeft = Math.max(4, Math.min(rawLeft, SCREEN_W - chartLeft - TOOLTIP_W - 4));
  const clampedBottom = Math.min(data.barY + 6, 90);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        {
          left: clampedLeft,
          bottom: clampedBottom,
          width: TOOLTIP_W,
          opacity: fadeAnim,
          transform: [{ scale: scaleAnim }],
        },
      ]}
    >
      {/* Label + Value */}
      <Text style={styles.label}>{data.label}</Text>
      <Text style={styles.value}>
        {isPercent ? `${value.toFixed(1)}%` : fmt$(value)}
      </Text>

      {/* Delta % */}
      {hasDelta && (
        <Text style={[styles.delta, { color: deltaColor(deltaPct!) }]}>
          {deltaPct! >= 0 ? '+' : ''}{deltaPct!.toFixed(1)}%
        </Text>
      )}

      {/* YoY — only if data exists */}
      {hasYoY && (
        <Text style={[styles.yoy, { color: deltaColor(yoyValue!) }]}>
          {yoyValue! >= 0 ? '+' : ''}{yoyValue!.toFixed(1)}% YoY
        </Text>
      )}

      {/* Arrow */}
      <View style={[styles.arrow, { left: Math.max(6, Math.min(data.barX - clampedLeft - 4, TOOLTIP_W - 14)) }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    backgroundColor: Colors.glassOverlay,
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    paddingHorizontal: 6,
    paddingVertical: 4,
    zIndex: 100,
    overflow: 'hidden',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
    }),
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textDim,
    textAlign: 'center',
  },
  value: {
    fontSize: 13,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
  },
  delta: {
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  yoy: {
    fontSize: 9,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 1,
  },
  arrow: {
    position: 'absolute',
    bottom: -4,
    width: 8,
    height: 8,
    backgroundColor: Colors.glassOverlay,
    borderRightWidth: 0.5,
    borderBottomWidth: 0.5,
    borderColor: Colors.glassBorder,
    transform: [{ rotate: '45deg' }],
  },
});
