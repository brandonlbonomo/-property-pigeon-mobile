import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Seamless brand gradient — Copilot-style.
 * Fades from brand green to fully transparent with no hard edge.
 * Uses position:'absolute' so it sits behind content.
 */
export function GradientHeader({
  height = 100,
}: {
  height?: number;
} = {}) {
  return (
    <View style={[styles.wrapper, { height }]} pointerEvents="none">
      <LinearGradient
        colors={[
          'rgba(22,163,74,0.28)',
          'rgba(26,188,88,0.18)',
          'rgba(30,206,110,0.06)',
          'rgba(30,206,110,0.00)',
        ]}
        locations={[0, 0.45, 0.85, 1]}
        style={StyleSheet.absoluteFillObject}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 0,
  },
});
