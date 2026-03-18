import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import {
  useCleanerStore, FollowedOwner, CleanerEvent,
  InvoiceLineItem, OwnerProperty,
} from '../../store/cleanerStore';

import { HostStep } from './wizard/HostStep';
import { PropertyStep } from './wizard/PropertyStep';
import { CalendarStep } from './wizard/CalendarStep';
import { ReviewStep } from './wizard/ReviewStep';

const RATES_KEY = 'pp_cleaning_rates';
const STEP_LABELS = ['Host', 'Properties', 'Calendar', 'Review'];

export function InvoiceWizardScreen({ navigation }: any) {
  const {
    owners, schedule, history,
    invoicedUids, fetchInvoicedUids, createInvoice,
    fetchSchedule, fetchHistory,
  } = useCleanerStore();

  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);

  // Wizard state
  const [selectedOwner, setSelectedOwner] = useState<FollowedOwner | null>(null);
  const [ownerProperties, setOwnerProperties] = useState<OwnerProperty[]>([]);
  const [selectedUnits, setSelectedUnits] = useState<Map<string, Set<string>>>(new Map());
  const [selectedCleanings, setSelectedCleanings] = useState<Map<string, CleanerEvent>>(new Map());
  const [manualLineItems, setManualLineItems] = useState<InvoiceLineItem[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});

  // Load rates + invoiced UIDs on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(RATES_KEY);
        if (raw) setRates(JSON.parse(raw));
      } catch {}
      await fetchInvoicedUids();
      await fetchSchedule(true);
      await fetchHistory(true);
    })();
  }, []);

  // All events for the selected owner
  const ownerEvents = useCallback(() => {
    if (!selectedOwner) return [];
    const allEvents = [...history, ...schedule];
    const seen = new Set<string>();
    return allEvents.filter(e => {
      if (e.owner_id !== selectedOwner.user_id) return false;
      if (seen.has(e.uid)) return false;
      seen.add(e.uid);
      return true;
    });
  }, [selectedOwner, history, schedule]);

  // Step handlers
  const handleSelectHost = (owner: FollowedOwner) => {
    setSelectedOwner(owner);
    setStep(1);
  };

  const handlePropertiesLoaded = (props: OwnerProperty[]) => {
    setOwnerProperties(props);
    // Auto-select all units
    const units = new Map<string, Set<string>>();
    props.forEach(p => {
      units.set(p.prop_id, new Set(p.units.map(u => u.feed_key)));
    });
    setSelectedUnits(units);
  };

  const handleToggleUnit = (propId: string, feedKey: string) => {
    setSelectedUnits(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(propId) || []);
      if (set.has(feedKey)) set.delete(feedKey);
      else set.add(feedKey);
      if (set.size === 0) next.delete(propId);
      else next.set(propId, set);
      return next;
    });
  };

  const handleSelectAll = () => {
    const units = new Map<string, Set<string>>();
    ownerProperties.forEach(p => {
      units.set(p.prop_id, new Set(p.units.map(u => u.feed_key)));
    });
    setSelectedUnits(units);
  };

  const handleDeselectAll = () => {
    setSelectedUnits(new Map());
  };

  const handleToggleCleaning = useCallback((uid: string, event: CleanerEvent) => {
    setSelectedCleanings(prev => {
      const next = new Map(prev);
      if (next.has(uid)) next.delete(uid);
      else next.set(uid, event);
      return next;
    });
  }, []);

  const handleRateChange = useCallback(async (propId: string, rate: number) => {
    setRates(prev => {
      const next = { ...prev, [propId]: rate };
      SecureStore.setItemAsync(RATES_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleRemoveCleaning = useCallback((uid: string) => {
    setSelectedCleanings(prev => {
      const next = new Map(prev);
      next.delete(uid);
      return next;
    });
  }, []);

  const handleAddManualItem = useCallback((item: InvoiceLineItem) => {
    setManualLineItems(prev => [...prev, item]);
  }, []);

  const handleRemoveManualItem = useCallback((index: number) => {
    setManualLineItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleCreateInvoice = useCallback(async (
    lineItems: InvoiceLineItem[],
    total: number,
    period: string,
    eventUids: string[],
  ) => {
    if (!selectedOwner) return;
    setCreating(true);
    try {
      const result = await createInvoice({
        hostId: selectedOwner.user_id,
        hostName: selectedOwner.username,
        period,
        lineItems,
        total,
        status: 'draft',
        event_uids: eventUids,
      });
      if (result) {
        // Save rates
        await SecureStore.setItemAsync(RATES_KEY, JSON.stringify(rates));
        // Refresh invoiced UIDs
        await fetchInvoicedUids();
        Alert.alert('Invoice Created', 'Your draft invoice has been created. You can review and send it from the Invoices tab.');
        navigation.goBack();
      } else {
        Alert.alert('Error', 'Could not create invoice. Some cleanings may have already been invoiced.');
      }
    } catch (err: any) {
      const msg = err?.serverError || err?.message || 'Failed to create invoice';
      Alert.alert('Error', msg);
    } finally {
      setCreating(false);
    }
  }, [selectedOwner, rates, createInvoice, fetchInvoicedUids, navigation]);

  const canGoNext = () => {
    if (step === 1) {
      return Array.from(selectedUnits.values()).some(s => s.size > 0);
    }
    if (step === 2) return selectedCleanings.size > 0;
    return true;
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {step > 0 ? (
          <TouchableOpacity activeOpacity={0.7} onPress={() => setStep(s => s - 1)}>
            <Ionicons name="chevron-back" size={22} color={Colors.primary} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>{STEP_LABELS[step]}</Text>
        {step < 3 && step > 0 ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => canGoNext() && setStep(s => s + 1)}
            disabled={!canGoNext()}
          >
            <Text style={[styles.nextText, !canGoNext() && { opacity: 0.4 }]}>Next</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 50 }} />
        )}
      </View>

      {/* Step dots */}
      <View style={styles.dotsRow}>
        {STEP_LABELS.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === step && styles.dotActive,
              i < step && styles.dotDone,
            ]}
          />
        ))}
      </View>

      {/* Step content */}
      <View style={styles.stepContent}>
        {step === 0 && (
          <HostStep owners={owners} onSelect={handleSelectHost} />
        )}
        {step === 1 && selectedOwner && (
          <PropertyStep
            ownerId={selectedOwner.user_id}
            selectedUnits={selectedUnits}
            onToggleUnit={handleToggleUnit}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
            onPropertiesLoaded={handlePropertiesLoaded}
          />
        )}
        {step === 2 && (
          <CalendarStep
            events={ownerEvents()}
            invoicedUids={invoicedUids}
            selectedUnits={selectedUnits}
            selectedCleanings={selectedCleanings}
            onToggleCleaning={handleToggleCleaning}
          />
        )}
        {step === 3 && selectedOwner && (
          <ReviewStep
            selectedCleanings={selectedCleanings}
            manualLineItems={manualLineItems}
            rates={rates}
            hostName={selectedOwner.username}
            onRateChange={handleRateChange}
            onRemoveCleaning={handleRemoveCleaning}
            onAddManualItem={handleAddManualItem}
            onRemoveManualItem={handleRemoveManualItem}
            onCreateInvoice={handleCreateInvoice}
            creating={creating}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingTop: Platform.OS === 'ios' ? 56 : Spacing.lg,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.bg,
  },
  cancelText: { fontSize: FontSize.md, color: Colors.red, fontWeight: '500' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  nextText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },
  dotsRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 8,
    paddingBottom: Spacing.sm,
  },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: Colors.glassDark,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  dotActive: {
    backgroundColor: Colors.glass,
    borderColor: Colors.primary, borderWidth: 2,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 6 },
    }),
  },
  dotDone: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  stepContent: { flex: 1 },
});
