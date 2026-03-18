import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { FollowedOwner } from '../../../store/cleanerStore';

interface Props {
  owners: FollowedOwner[];
  onSelect: (owner: FollowedOwner) => void;
}

export function HostStep({ owners, onSelect }: Props) {
  if (owners.length === 0) {
    return (
      <View style={styles.empty}>
        <Ionicons name="people-outline" size={48} color={Colors.textDim} />
        <Text style={styles.emptyTitle}>No Hosts</Text>
        <Text style={styles.emptySub}>Follow a host first to create invoices.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Select a host to invoice</Text>
      {owners.map((owner) => (
        <TouchableOpacity
          key={owner.id}
          activeOpacity={0.7}
          style={styles.card}
          onPress={() => onSelect(owner)}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(owner.username || '?')[0].toUpperCase()}
            </Text>
          </View>
          <View style={styles.info}>
            <Text style={styles.name}>{owner.username}</Text>
            <Text style={styles.sub}>
              {owner.property_count || 0} propert{owner.property_count === 1 ? 'y' : 'ies'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textDim} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Spacing.md },
  heading: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.md,
  },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
    }),
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.md,
  },
  avatarText: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.primary },
  info: { flex: 1 },
  name: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: Spacing.xl,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs },
});
