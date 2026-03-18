import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { OwnerProperty, PropertyUnit, useCleanerStore } from '../../../store/cleanerStore';

interface Props {
  ownerId: string;
  selectedUnits: Map<string, Set<string>>; // prop_id → Set<feed_key>
  onToggleUnit: (propId: string, feedKey: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onPropertiesLoaded: (props: OwnerProperty[]) => void;
}

export function PropertyStep({
  ownerId, selectedUnits, onToggleUnit, onSelectAll, onDeselectAll, onPropertiesLoaded,
}: Props) {
  const fetchOwnerUnits = useCleanerStore(s => s.fetchOwnerUnits);
  const [properties, setProperties] = useState<OwnerProperty[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const result = await fetchOwnerUnits(ownerId);
      setProperties(result);
      onPropertiesLoaded(result);
      setLoading(false);
    })();
  }, [ownerId]);

  const totalSelected = Array.from(selectedUnits.values()).reduce((s, set) => s + set.size, 0);
  const totalUnits = properties.reduce((s, p) => s + p.units.length, 0);
  const allSelected = totalSelected === totalUnits && totalUnits > 0;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Select properties to invoice</Text>

      <TouchableOpacity
        activeOpacity={0.7}
        style={styles.selectAllBtn}
        onPress={allSelected ? onDeselectAll : onSelectAll}
      >
        <Ionicons
          name={allSelected ? 'checkbox' : 'square-outline'}
          size={22}
          color={allSelected ? Colors.primary : Colors.textDim}
        />
        <Text style={[styles.selectAllText, allSelected && { color: Colors.primary }]}>
          {allSelected ? 'Deselect All' : 'Select All'}
        </Text>
      </TouchableOpacity>

      {properties.map((prop) => {
        const propSelected = selectedUnits.get(prop.prop_id) || new Set<string>();
        return (
          <View key={prop.prop_id} style={styles.propSection}>
            <Text style={styles.propLabel}>{prop.prop_label}</Text>
            {prop.units.map((unit) => {
              const isChecked = propSelected.has(unit.feed_key);
              return (
                <TouchableOpacity
                  key={unit.feed_key || unit.unit_name}
                  activeOpacity={0.7}
                  style={styles.unitRow}
                  onPress={() => onToggleUnit(prop.prop_id, unit.feed_key)}
                >
                  <Ionicons
                    name={isChecked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={isChecked ? Colors.primary : Colors.textDim}
                  />
                  <Text style={[styles.unitName, isChecked && { color: Colors.text }]}>
                    {unit.unit_name || prop.prop_label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heading: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.md,
  },
  selectAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm, marginBottom: Spacing.sm,
  },
  selectAllText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary },
  propSection: { marginBottom: Spacing.md },
  propLabel: {
    fontSize: FontSize.sm, fontWeight: '700', color: Colors.textDim,
    letterSpacing: 0.5, textTransform: 'uppercase',
    marginBottom: Spacing.xs,
  },
  unitRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: Spacing.xs,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 8 },
    }),
  },
  unitName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.textSecondary, flex: 1 },
});
