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
  onToggleProperty: (propId: string, unitKeys: string[], select: boolean) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onPropertiesLoaded: (props: OwnerProperty[]) => void;
}

export function PropertyStep({
  ownerId, selectedUnits, onToggleUnit, onToggleProperty, onSelectAll, onDeselectAll, onPropertiesLoaded,
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

  // Property-level selection: a property is selected if ANY of its units are in selectedUnits
  const isPropertySelected = (prop: OwnerProperty) => {
    const selected = selectedUnits.get(prop.prop_id);
    if (!selected || selected.size === 0) return false;
    return prop.units.some(u => selected.has(u.feed_key || prop.prop_id));
  };

  const toggleProperty = (prop: OwnerProperty) => {
    const isSelected = isPropertySelected(prop);
    const keys = prop.units.map(u => u.feed_key || prop.prop_id);
    onToggleProperty(prop.prop_id, keys, !isSelected);
  };

  const totalProps = properties.length;
  const selectedProps = properties.filter(p => isPropertySelected(p)).length;
  const allSelected = selectedProps === totalProps && totalProps > 0;
  const someSelected = selectedProps > 0 && !allSelected;

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

      {/* Select All */}
      <TouchableOpacity
        activeOpacity={0.5}
        style={[
          styles.selectAllBtn,
          someSelected && styles.selectAllBtnPartial,
          allSelected && styles.selectAllBtnActive,
        ]}
        onPress={allSelected ? onDeselectAll : onSelectAll}
      >
        <Ionicons
          name={allSelected ? 'checkbox' : someSelected ? 'remove-circle-outline' : 'square-outline'}
          size={24}
          color={allSelected ? Colors.green : someSelected ? Colors.yellow : Colors.textDim}
        />
        <Text style={[
          styles.selectAllText,
          someSelected && { color: Colors.yellow },
          allSelected && { color: Colors.green },
        ]}>
          {allSelected ? 'All Selected' : 'Select All'}
        </Text>
        {!allSelected && (
          <Text style={[styles.selectAllCount, someSelected && { color: Colors.yellow }]}>
            {selectedProps}/{totalProps}
          </Text>
        )}
        {allSelected && <Ionicons name="checkmark-circle" size={20} color={Colors.green} />}
      </TouchableOpacity>

      {/* Property cards — one per property, not per unit */}
      {properties.map((prop) => {
        const selected = isPropertySelected(prop);
        const unitCount = prop.units.length;
        return (
          <TouchableOpacity
            key={prop.prop_id}
            activeOpacity={0.6}
            style={[styles.propCard, selected && styles.propCardSelected]}
            onPress={() => toggleProperty(prop)}
          >
            <Ionicons
              name={selected ? 'checkbox' : 'square-outline'}
              size={24}
              color={selected ? Colors.green : Colors.textDim}
            />
            <View style={{ flex: 1, marginLeft: Spacing.sm }}>
              <Text style={[styles.propName, selected && styles.propNameSelected]}>
                {prop.prop_label}
              </Text>
              {unitCount > 1 && (
                <Text style={styles.propUnits}>{unitCount} units</Text>
              )}
            </View>
          </TouchableOpacity>
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

  // Select All
  selectAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md, borderRadius: Radius.lg,
    backgroundColor: Colors.glassDark,
    borderWidth: 1, borderColor: Colors.glassBorder,
  },
  selectAllBtnPartial: {
    backgroundColor: Colors.yellowDim,
    borderColor: Colors.yellow + '40',
  },
  selectAllBtnActive: {
    backgroundColor: Colors.greenDim,
    borderColor: Colors.green + '40',
  },
  selectAllText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, flex: 1 },
  selectAllCount: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textDim },

  // Property cards
  propCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1.5, borderColor: Colors.glassBorder,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 8 },
    }),
  },
  propCardSelected: {
    borderColor: Colors.green + '50',
    backgroundColor: Colors.greenDim,
  },
  propName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  propNameSelected: { color: Colors.text },
  propUnits: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
});
