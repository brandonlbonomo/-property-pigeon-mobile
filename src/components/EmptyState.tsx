import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, FontSize, Spacing } from '../constants/theme';

interface Props {
  message: string;
  sub?: string;
}

export function EmptyState({ message, sub }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.dash}>--</Text>
      <Text style={styles.message}>{message}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xl * 2,
  },
  dash: {
    fontSize: 28,
    color: Colors.textDim,
    marginBottom: Spacing.md,
  },
  message: {
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  sub: {
    fontSize: FontSize.sm,
    color: Colors.textDim,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
});
