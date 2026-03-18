import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Platform, Dimensions, Animated } from 'react-native';
import { Colors, FontSize, Radius, Spacing } from '../constants/theme';
import { fmt$ } from '../utils/format';

const SCREEN_W = Dimensions.get('window').width;
const TOOLTIP_W = 160;

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
  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const translateYAnim = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    fadeAnim.setValue(0);
    scaleAnim.setValue(0.85);
    translateYAnim.setValue(8);
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 80,
        friction: 10,
        useNativeDriver: true,
      }),
      Animated.timing(translateYAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [data.barIndex]);

  // Delta vs prior bar
  const delta = priorValue != null ? value - priorValue : null;
  const deltaPct = priorValue != null && priorValue !== 0
    ? ((value - priorValue) / Math.abs(priorValue)) * 100
    : null;

  // Format value
  const displayVal = isPercent ? `${value.toFixed(1)}%` : fmt$(value);

  // Delta coloring with inversion support
  const deltaColor = (d: number) => {
    if (invertDelta) return d <= 0 ? Colors.green : Colors.red;
    return d >= 0 ? Colors.green : Colors.red;
  };

  // Clamp tooltip position within screen bounds
  const rawLeft = data.barX - TOOLTIP_W / 2;
  const clampedLeft = Math.max(4, Math.min(rawLeft, SCREEN_W - chartLeft - TOOLTIP_W - 4));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        {
          left: clampedLeft,
          bottom: data.barY + 8,
          width: TOOLTIP_W,
          opacity: fadeAnim,
          transform: [
            { scale: scaleAnim },
            { translateY: translateYAnim },
          ],
        },
      ]}
    >
      {/* Inner shine bar */}
      <View style={styles.shineBar} />

      <Text style={styles.value}>{displayVal}</Text>
      {delta != null && (
        <Text style={[styles.delta, { color: deltaColor(delta) }]}>
          {delta >= 0 ? '+' : ''}
          {isPercent ? `${delta.toFixed(1)}pp` : fmt$(delta)}
          {deltaPct != null ? ` / ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%` : ''}
          {data.priorLabel ? ` vs ${data.priorLabel}` : ''}
        </Text>
      )}
      {yoyValue != null && (
        <Text style={[styles.yoy, { color: deltaColor(yoyValue) }]}>
          {yoyValue >= 0 ? '+' : ''}{yoyValue.toFixed(1)}% YoY
        </Text>
      )}

      {/* Arrow */}
      <View style={[styles.arrow, { left: Math.max(8, Math.min(data.barX - clampedLeft - 5, TOOLTIP_W - 18)) }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    backgroundColor: Colors.glassOverlay,
    borderRadius: Radius.lg,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: Spacing.sm,
    zIndex: 100,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
      android: { elevation: 8 },
    }),
  },
  shineBar: {
    position: 'absolute',
    top: 1,
    left: 1,
    right: 1,
    height: 1,
    backgroundColor: Colors.glassShine,
  },
  value: {
    fontSize: FontSize.md,
    fontWeight: '700',
    color: Colors.text,
    textAlign: 'center',
  },
  delta: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
  yoy: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 1,
  },
  arrow: {
    position: 'absolute',
    bottom: -5,
    width: 10,
    height: 10,
    backgroundColor: Colors.glassOverlay,
    borderRightWidth: 0.5,
    borderBottomWidth: 0.5,
    borderColor: Colors.glassBorder,
    transform: [{ rotate: '45deg' }],
  },
});
