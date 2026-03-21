import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors } from '../constants/theme';

/**
 * Seamless brand gradient — subtle green glow that melts into the light background.
 * Uses position:'absolute' so it sits behind content.
 */
export function GradientHeader({
  height = 140,
}: {
  height?: number;
} = {}) {
  return (
    <View style={[styles.wrapper, { height }]} pointerEvents="none">
      <LinearGradient
        colors={[
          'rgba(30,206,110,0.14)',
          'rgba(30,206,110,0.06)',
          'rgba(30,206,110,0.01)',
          Colors.bg,
        ]}
        locations={[0, 0.35, 0.65, 1]}
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
    zIndex: -1,
  },
});
