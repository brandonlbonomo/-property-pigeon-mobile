import React, { useState } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet,
  Platform, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';

export interface PickerUnit {
  feed_key: string;
  unit_name: string;
}

export interface PickerProperty {
  id: string;
  label: string;
  units?: PickerUnit[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
  properties: PickerProperty[];
  currentlySelected: string[];
  currentlySelectedFeedKeys?: string[];
  actionLabel: string;
  onSubmit: (propertyIds: string[], feedKeys: string[]) => void;
  loading?: boolean;
}

export function PropertyPickerModal({
  visible, onClose, properties, currentlySelected, currentlySelectedFeedKeys,
  actionLabel, onSubmit, loading,
}: Props) {
  const insets = useSafeAreaInsets();
  const [selectedProps, setSelectedProps] = useState<Set<string>>(new Set(currentlySelected));
  const [selectedFeedKeys, setSelectedFeedKeys] = useState<Set<string>>(
    new Set(currentlySelectedFeedKeys || [])
  );
  const [expandedProps, setExpandedProps] = useState<Set<string>>(new Set());

  // Reset on open
  React.useEffect(() => {
    if (visible) {
      setSelectedProps(new Set(currentlySelected));
      setSelectedFeedKeys(new Set(currentlySelectedFeedKeys || []));
      setExpandedProps(new Set());
    }
  }, [visible]);

  const hasMultipleUnits = (prop: PickerProperty) =>
    prop.units && prop.units.length > 1;

  const toggleExpand = (propId: string) => {
    setExpandedProps(prev => {
      const next = new Set(prev);
      if (next.has(propId)) next.delete(propId);
      else next.add(propId);
      return next;
    });
  };

  const toggleProperty = (prop: PickerProperty) => {
    const multiUnit = hasMultipleUnits(prop);

    setSelectedProps(prev => {
      const next = new Set(prev);
      if (next.has(prop.id)) {
        next.delete(prop.id);
        // Also deselect all feed keys for this prop
        if (multiUnit && prop.units) {
          setSelectedFeedKeys(fk => {
            const nfk = new Set(fk);
            prop.units!.forEach(u => nfk.delete(u.feed_key));
            return nfk;
          });
        }
      } else {
        next.add(prop.id);
        // Auto-select all units
        if (multiUnit && prop.units) {
          setSelectedFeedKeys(fk => {
            const nfk = new Set(fk);
            prop.units!.forEach(u => nfk.add(u.feed_key));
            return nfk;
          });
          // Auto-expand
          setExpandedProps(ep => new Set([...ep, prop.id]));
        } else if (prop.units?.length === 1) {
          setSelectedFeedKeys(fk => new Set([...fk, prop.units![0].feed_key]));
        }
      }
      return next;
    });
  };

  const toggleUnit = (prop: PickerProperty, feedKey: string) => {
    setSelectedFeedKeys(prev => {
      const next = new Set(prev);
      if (next.has(feedKey)) {
        next.delete(feedKey);
        // If no units selected, deselect the property
        const remainingForProp = prop.units?.filter(u => next.has(u.feed_key)) || [];
        if (remainingForProp.length === 0) {
          setSelectedProps(sp => { const n = new Set(sp); n.delete(prop.id); return n; });
        }
      } else {
        next.add(feedKey);
        // Ensure property is selected
        setSelectedProps(sp => new Set([...sp, prop.id]));
      }
      return next;
    });
  };

  const handleSubmit = () => {
    onSubmit(Array.from(selectedProps), Array.from(selectedFeedKeys));
  };

  const selectionCount = selectedProps.size;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top + Spacing.sm }]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Select Properties</Text>
          <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close-circle" size={28} color={Colors.textDim} />
          </TouchableOpacity>
        </View>

        <Text style={styles.subtitle}>
          Only properties with iCal feeds are shown. Tap to expand units.
        </Text>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {properties.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="home-outline" size={40} color={Colors.textDim} />
              <Text style={styles.emptyText}>No iCal-linked properties found</Text>
            </View>
          ) : (
            properties.map(prop => {
              const isSelected = selectedProps.has(prop.id);
              const multiUnit = hasMultipleUnits(prop);
              const isExpanded = expandedProps.has(prop.id);

              return (
                <View key={prop.id}>
                  {/* Property row */}
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.propRow, isSelected && styles.propRowActive]}
                    onPress={() => toggleProperty(prop)}
                  >
                    <Ionicons
                      name={isSelected ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={isSelected ? Colors.green : Colors.textDim}
                    />
                    <View style={styles.propInfo}>
                      <Text style={styles.propLabel}>{prop.label}</Text>
                      {multiUnit && (
                        <Text style={styles.unitCount}>
                          {prop.units!.length} units
                        </Text>
                      )}
                    </View>
                    {multiUnit && (
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => toggleExpand(prop.id)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={Colors.textSecondary}
                        />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>

                  {/* Unit dropdown */}
                  {multiUnit && isExpanded && prop.units!.map(unit => {
                    const unitSelected = selectedFeedKeys.has(unit.feed_key);
                    return (
                      <TouchableOpacity
                        key={unit.feed_key}
                        activeOpacity={0.7}
                        style={[styles.unitRow, unitSelected && styles.unitRowActive]}
                        onPress={() => toggleUnit(prop, unit.feed_key)}
                      >
                        <Ionicons
                          name={unitSelected ? 'checkbox' : 'square-outline'}
                          size={18}
                          color={unitSelected ? Colors.green : Colors.textDim}
                        />
                        <Text style={styles.unitLabel}>{unit.unit_name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })
          )}
        </ScrollView>

        {/* Action button */}
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
          <TouchableOpacity
            activeOpacity={0.7}
            style={[styles.submitBtn, selectionCount === 0 && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={selectionCount === 0 || loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitText}>
                {actionLabel}{selectionCount > 0 ? ` (${selectionCount})` : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
    textAlign: 'center',
  },
  closeBtn: {
    position: 'absolute',
    right: Spacing.md,
    padding: 2,
  },
  subtitle: {
    fontSize: FontSize.xs,
    color: Colors.textDim,
    textAlign: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.xl * 2,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textDim,
    marginTop: Spacing.sm,
  },
  propRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    marginBottom: Spacing.xs,
  },
  propRowActive: {
    backgroundColor: Colors.greenDim,
    borderColor: Colors.green + '40',
  },
  propInfo: {
    flex: 1,
  },
  propLabel: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.text,
  },
  unitCount: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md + Spacing.lg,
    borderRadius: Radius.md,
    backgroundColor: Colors.glassDark,
    marginLeft: Spacing.lg,
    marginRight: Spacing.xs,
    marginBottom: Spacing.xs,
  },
  unitRowActive: {
    backgroundColor: Colors.greenDim,
  },
  unitLabel: {
    fontSize: FontSize.xs,
    color: Colors.text,
    flex: 1,
  },
  footer: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  submitBtn: {
    backgroundColor: Colors.green,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.4,
  },
  submitText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: '600',
  },
});
