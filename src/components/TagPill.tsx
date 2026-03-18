import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Radius, FontSize, Spacing } from '../constants/theme';

// Color palette for property-based tags (cycle through)
const PALETTE = [
  { bg: 'rgba(255,255,255,0.08)', text: '#A1A1AA' },  // charcoal
  { bg: 'rgba(16,185,129,0.15)', text: '#34D399' },    // green
  { bg: 'rgba(245,158,11,0.15)', text: '#FBBF24' },    // amber
  { bg: 'rgba(139,92,246,0.15)', text: '#A78BFA' },    // violet
  { bg: 'rgba(236,72,153,0.15)', text: '#F472B6' },    // pink
  { bg: 'rgba(249,115,22,0.15)', text: '#FB923C' },    // orange
  { bg: 'rgba(99,102,241,0.15)', text: '#818CF8' },    // indigo
  { bg: 'rgba(20,184,166,0.15)', text: '#2DD4BF' },    // teal
];

// Special tag definitions
export const SPECIAL_TAGS: Record<string, { emoji: string; label: string; bg: string; text: string }> = {
  __internal_transfer__: { emoji: '🔄', label: 'INTERNAL TRANSFER', bg: 'rgba(99,102,241,0.15)', text: '#818CF8' },
  __llc_expense__:       { emoji: '💼', label: 'GENERAL LLC EXPENSE', bg: 'rgba(245,158,11,0.15)', text: '#FBBF24' },
  __delete__:            { emoji: '🗑️', label: 'DELETE', bg: 'rgba(239,68,68,0.15)', text: '#F87171' },
};

export function isSpecialTag(tagId: string): boolean {
  return tagId in SPECIAL_TAGS;
}

/** Get consistent color for a property based on its index in the list */
export function getPropertyColor(index: number) {
  return PALETTE[index % PALETTE.length];
}

interface TagPillProps {
  tagId: string;
  label?: string;
  propertyIndex?: number;
  selected?: boolean;
  onPress?: () => void;
  size?: 'sm' | 'md';
}

export function TagPill({ tagId, label, propertyIndex = 0, selected, onPress, size = 'sm' }: TagPillProps) {
  const special = SPECIAL_TAGS[tagId];
  const color = special
    ? { bg: special.bg, text: special.text }
    : getPropertyColor(propertyIndex);
  const emoji = special?.emoji ?? '🏠';
  const displayLabel = special?.label ?? (label || tagId || 'Tag').toUpperCase();

  const isSm = size === 'sm';
  const pillStyle = [
    styles.pill,
    { backgroundColor: color.bg },
    selected && { borderColor: color.text, borderWidth: 2 },
    isSm ? styles.pillSm : styles.pillMd,
  ];
  const textStyle = [
    styles.label,
    { color: color.text },
    isSm ? styles.labelSm : styles.labelMd,
  ];

  const content = (
    <View style={pillStyle}>
      <Text style={isSm ? styles.emojiSm : styles.emojiMd}>{emoji}</Text>
      <Text style={textStyle} numberOfLines={1}>{displayLabel}</Text>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.7} onPress={onPress}>
        {content}
      </TouchableOpacity>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  pillSm: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    gap: 4,
  },
  pillMd: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    gap: 6,
  },
  label: {
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  labelSm: {
    fontSize: FontSize.xs - 1,
  },
  labelMd: {
    fontSize: FontSize.xs,
  },
  emojiSm: {
    fontSize: 10,
  },
  emojiMd: {
    fontSize: 14,
  },
});
