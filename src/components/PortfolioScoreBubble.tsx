import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Colors, FontSize, Radius } from '../constants/theme';

interface Props {
  score: number | null | undefined;
  size?: number;
  showLabel?: boolean;
}

function scoreColor(score: number): string {
  if (score >= 70) return Colors.green;
  if (score >= 40) return Colors.yellow;
  return Colors.red;
}

export function PortfolioScoreBubble({ score, size = 76, showLabel = false }: Props) {
  const s = score ?? 0;
  const color = scoreColor(s);
  const fontSize = size >= 64 ? 24 : size >= 44 ? 16 : size >= 36 ? 13 : 10;
  const borderW = size >= 64 ? 2.5 : size >= 44 ? 2 : 1.5;

  return (
    <View style={{ alignItems: 'center' }}>
      <View
        style={[
          styles.bubble,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: borderW,
            borderColor: color + '55',
          },
        ]}
      >
        {/* Inner glow ring */}
        <View
          style={[
            styles.innerGlow,
            {
              width: size - 8,
              height: size - 8,
              borderRadius: (size - 8) / 2,
              borderColor: color + '25',
            },
          ]}
        />
        {/* Score number */}
        <Text style={[styles.scoreText, { fontSize, color }]}>
          {score != null ? s : '—'}
        </Text>
      </View>
      {showLabel && (
        <Text style={styles.label}>Portfolio Score</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    backgroundColor: Colors.glass,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.5,
        shadowRadius: 16,
      },
    }),
  },
  innerGlow: {
    position: 'absolute',
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  scoreText: {
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  label: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textDim,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
});
