import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { Card } from './Card';

interface Props {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  style?: ViewStyle;
}

export function MetricCard({ label, value, sub, accent, style }: Props) {
  return (
    <Card style={style}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, accent ? { color: accent } : {}]}>{value}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.xs,
  },
  value: {
    fontSize: FontSize.xxl,
    fontWeight: '700',
    color: Colors.text,
  },
  sub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
});
