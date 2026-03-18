import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator, Alert, Platform,
  Modal, TextInput, KeyboardAvoidingView,
  Dimensions, Animated, NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useCleanerStore, CleanerInvoice, CleanerEvent, InvoiceLineItem } from '../../store/cleanerStore';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { Card } from '../../components/Card';
import { SwipePills } from '../../components/SwipePills';
import { fmt$ } from '../../utils/format';


const SCREEN_W = Dimensions.get('window').width;
const RATES_KEY = 'pp_cleaning_rates';

const CLEANING_TYPES = [
  'Standard Cleaning',
  'Extra Cleaning',
  'Deep Cleaning',
  'Errand Run',
  'Supply Drop Off',
  'Purchase of Supplies',
] as const;

type InvoiceTab = 'Pending' | 'Sent' | 'All';
const TABS: InvoiceTab[] = ['Pending', 'Sent', 'All'];
type CreatePeriod = 'weekly' | 'monthly';

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: Colors.yellowDim, text: Colors.yellow },
  sent: { bg: Colors.primaryDim, text: Colors.primary },
  paid: { bg: Colors.greenDim, text: Colors.green },
};

function getLastWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diffToMonday = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - diffToMonday);
  thisMonday.setHours(0, 0, 0, 0);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);

  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastSunday.setHours(23, 59, 59, 999);

  const label = `${lastMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${lastSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return { start: lastMonday, end: lastSunday, label };
}

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <View style={[styles.statusBadge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.statusText, { color: colors.text }]}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Text>
    </View>
  );
}

/* ── Edit / Add Line Item Modal ─────────────────────────────── */
interface EditLineState {
  invoiceId: string;
  index: number | null; // null = adding new
  type: string;
  description: string;
  amount: string;
  date: string;
}

function EditLineModal({
  state,
  onSave,
  onClose,
}: {
  state: EditLineState | null;
  onSave: (s: EditLineState) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (state) {
      setType(state.type || CLEANING_TYPES[0]);
      setDescription(state.description);
      setAmount(state.amount);
    }
  }, [state]);

  if (!state) return null;

  const isEditing = state.index !== null;
  const amountNum = parseFloat(amount) || 0;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>{isEditing ? 'Edit Line Item' : 'Add Line Item'}</Text>

          {/* Type picker */}
          <Text style={styles.modalLabel}>Type</Text>
          <View style={styles.typePills}>
            {CLEANING_TYPES.map(t => (
              <TouchableOpacity
                key={t}
                activeOpacity={0.7}
                style={[styles.typePill, type === t && styles.typePillActive]}
                onPress={() => setType(t)}
              >
                <Text style={[styles.typePillText, type === t && styles.typePillTextActive]}>
                  {t}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Description */}
          <Text style={styles.modalLabel}>Description (optional)</Text>
          <TextInput
            style={styles.modalInput}
            value={description}
            onChangeText={setDescription}
            placeholder="e.g. Beach House, extra towels"
            placeholderTextColor={Colors.textDim}
          />

          {/* Amount */}
          <Text style={styles.modalLabel}>Amount</Text>
          <View style={styles.amountRow}>
            <Text style={styles.amountDollar}>$</Text>
            <TextInput
              style={[styles.modalInput, { flex: 1 }]}
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={Colors.textDim}
              keyboardType="decimal-pad"
            />
          </View>

          <View style={styles.modalActions}>
            <TouchableOpacity activeOpacity={0.7} style={styles.modalCancel} onPress={onClose}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.modalSave, amountNum <= 0 && { opacity: 0.4 }]}
              disabled={amountNum <= 0}
              onPress={() => onSave({ ...state, type, description, amount: amountNum.toString() })}
            >
              <Text style={styles.modalSaveText}>{isEditing ? 'Save' : 'Add'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ── Invoice Card ────────────────────────────────────────────── */
function InvoiceCard({
  invoice,
  onSend,
  onDelete,
  onEditLine,
  onAddLine,
  onDeleteLine,
}: {
  invoice: CleanerInvoice;
  onSend: (id: string) => void;
  onDelete: (id: string) => void;
  onEditLine: (invoiceId: string, index: number, item: InvoiceLineItem) => void;
  onAddLine: (invoiceId: string) => void;
  onDeleteLine: (invoiceId: string, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDraft = invoice.status === 'draft';

  return (
    <Card>
      <TouchableOpacity activeOpacity={0.7} onPress={() => setExpanded(!expanded)}>
        <View style={styles.invoiceHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.invoiceHost}>{invoice.hostName}</Text>
            <Text style={styles.invoicePeriod}>{invoice.period}</Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={[styles.invoiceTotal, { color: Colors.green }]}>{fmt$(invoice.total)}</Text>
            <StatusBadge status={invoice.status} />
          </View>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.invoiceDetail}>
          {invoice.lineItems.map((item, i) => (
            <View key={i} style={styles.lineItem}>
              <View style={styles.lineItemTop}>
                <Text style={styles.lineDate}>
                  {item.date ? new Date(item.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                </Text>
                {item.propertyName ? (
                  <Text style={styles.lineProp} numberOfLines={1}> · {item.propertyName}</Text>
                ) : null}
                <View style={{ flex: 1 }} />
                {isDraft && (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPress={() => onDeleteLine(invoice.id, i)}
                  >
                    <Ionicons name="close-circle" size={18} color={Colors.red} />
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity
                activeOpacity={isDraft ? 0.7 : 1}
                style={styles.lineItemBottom}
                onPress={() => isDraft && onEditLine(invoice.id, i, item)}
                disabled={!isDraft}
              >
                <View style={[styles.typeTag, isDraft && styles.typeTagTappable]}>
                  <Text style={styles.typeTagText}>{item.cleaningType || 'Standard Cleaning'}</Text>
                  {isDraft && <Ionicons name="chevron-down" size={10} color={Colors.primary} />}
                </View>
                <Text style={styles.lineAmount}>{fmt$(item.amount)}</Text>
              </TouchableOpacity>
            </View>
          ))}

          {/* Total */}
          <View style={styles.lineTotalRow}>
            <Text style={styles.lineTotalLabel}>Total</Text>
            <Text style={styles.lineTotalValue}>{fmt$(invoice.total)}</Text>
          </View>

          {isDraft && (
            <>
              {/* Add Line Item */}
              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.addLineBtn}
                onPress={() => onAddLine(invoice.id)}
              >
                <Ionicons name="add-circle-outline" size={16} color={Colors.primary} />
                <Text style={styles.addLineBtnText}>Add Line Item</Text>
              </TouchableOpacity>

              <View style={styles.draftActions}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.deleteBtn}
                  onPress={() => onDelete(invoice.id)}
                >
                  <Ionicons name="trash-outline" size={14} color={Colors.red} />
                  <Text style={styles.deleteBtnText}>Delete</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.sendBtn}
                  onPress={() => onSend(invoice.id)}
                >
                  <Ionicons name="send-outline" size={14} color="#fff" />
                  <Text style={styles.sendBtnText}>Send to Host</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      )}
    </Card>
  );
}

/* ── Main Screen ─────────────────────────────────────────────── */
export function CleanerInvoicesScreen() {
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const navigation = useNavigation<any>();
  const {
    invoices, schedule, history, fetchInvoices, createInvoice,
    updateInvoice, deleteInvoice, sendInvoice,
    fetchSchedule, fetchHistory, owners,
  } = useCleanerStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<InvoiceTab>('Pending');
  const [creating, setCreating] = useState(false);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [createPeriod, setCreatePeriod] = useState<CreatePeriod>('weekly');
  const [editLine, setEditLine] = useState<EditLineState | null>(null);

  const scrollX = useRef(new Animated.Value(0)).current;
  const horizontalRef = useRef<ScrollView>(null);

  const handlePillSelect = useCallback((key: InvoiceTab) => {
    const idx = TABS.indexOf(key);
    horizontalRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
    setTab(key);
  }, []);

  const onMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (idx >= 0 && idx < TABS.length) setTab(TABS[idx]);
  }, []);

  const pendingInvoices = useMemo(() => invoices.filter(inv => inv.status === 'draft'), [invoices]);
  const sentInvoices = useMemo(() => invoices.filter(inv => inv.status === 'sent' || inv.status === 'paid'), [invoices]);
  const allInvoices = invoices;

  useEffect(() => {
    const init = async () => {
      await loadRates();
      if (!isReadOnly) {
        await Promise.all([fetchInvoices(), fetchSchedule(), fetchHistory()]);
      }
    };
    init()
      .catch(() => setError('Could not load invoices.'))
      .finally(() => setLoading(false));
  }, [isReadOnly]);

  const loadRates = async () => {
    try {
      const raw = await SecureStore.getItemAsync(RATES_KEY);
      if (raw) setRates(JSON.parse(raw));
    } catch {}
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all([fetchInvoices(), fetchSchedule(true), fetchHistory(true)]);
      await loadRates();
    } catch { setError('Could not load invoices.'); }
    finally { setRefreshing(false); }
  }, [fetchInvoices, fetchSchedule, fetchHistory]);

  // Pro gate
  if (isReadOnly) {
    return (
      <View style={styles.lockedContainer}>
        <View style={styles.lockedCircle}>
          <Ionicons name="lock-closed" size={36} color={Colors.textDim} />
        </View>
        <Text style={styles.lockedTitle}>Unlock Invoices</Text>
        <Text style={styles.lockedDesc}>
          Subscribe to Cleaner Pro to auto-generate invoices from your cleaning schedule and send them to hosts.
        </Text>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.lockedBtn, checkout.loading && { opacity: 0.6 }]}
          onPress={checkout.startCheckout}
          disabled={checkout.loading}
        >
          {checkout.loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="diamond-outline" size={16} color="#fff" />
              <Text style={styles.lockedBtnText}>Subscribe to Pro</Text>
            </>
          )}
        </TouchableOpacity>
        {Platform.OS === 'ios' && (
          <TouchableOpacity activeOpacity={0.7} style={styles.restoreLink} onPress={async () => {
            const { restorePurchases } = require('../../services/revenueCat');
            const info = await restorePurchases();
            if (info) { await require('../../store/userStore').useUserStore.getState().fetchBillingStatus(); }
          }}>
            <Text style={styles.restoreLinkText}>Restore Purchases</Text>
          </TouchableOpacity>
        )}
        </View>
    );
  }

  const handleSend = async (id: string) => {
    Alert.alert('Send Invoice', 'Mark this invoice as sent to the host?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: () => sendInvoice(id) },
    ]);
  };

  const handleDelete = (id: string) => {
    Alert.alert('Delete Invoice', 'Are you sure you want to delete this draft?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteInvoice(id) },
    ]);
  };

  const handleDeleteLine = (invoiceId: string, index: number) => {
    const inv = invoices.find(i => i.id === invoiceId);
    if (!inv) return;
    const newItems = inv.lineItems.filter((_, i) => i !== index);
    if (newItems.length === 0) {
      handleDelete(invoiceId);
      return;
    }
    const newTotal = newItems.reduce((s, li) => s + li.amount, 0);
    updateInvoice(invoiceId, newItems, newTotal);
  };

  const handleEditLine = (invoiceId: string, index: number, item: InvoiceLineItem) => {
    setEditLine({
      invoiceId,
      index,
      type: item.cleaningType || 'Standard Cleaning',
      description: item.propertyName,
      amount: item.amount.toString(),
      date: item.date,
    });
  };

  const handleAddLine = (invoiceId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    setEditLine({
      invoiceId,
      index: null,
      type: CLEANING_TYPES[0],
      description: '',
      amount: '',
      date: today,
    });
  };

  const handleSaveLine = (state: EditLineState) => {
    const inv = invoices.find(i => i.id === state.invoiceId);
    if (!inv) return;

    const newItem: InvoiceLineItem = {
      date: state.date,
      propertyName: state.description,
      cleaningType: state.type,
      rate: parseFloat(state.amount) || 0,
      amount: parseFloat(state.amount) || 0,
    };

    let newItems: InvoiceLineItem[];
    if (state.index !== null) {
      newItems = inv.lineItems.map((li, i) => (i === state.index ? newItem : li));
    } else {
      newItems = [...inv.lineItems, newItem];
    }

    const newTotal = newItems.reduce((s, li) => s + li.amount, 0);
    updateInvoice(state.invoiceId, newItems, newTotal);
    setEditLine(null);
  };

  const handleCreate = async () => {
    if (owners.length === 0) {
      Alert.alert('No Hosts', 'Follow an owner first to create invoices.');
      return;
    }

    const allEvents = [...history, ...schedule];
    const seen = new Set<string>();
    const uniqueEvents = allEvents.filter(e => {
      if (seen.has(e.uid)) return false;
      seen.add(e.uid);
      return true;
    });

    let dateFilter: (e: CleanerEvent) => boolean;
    let periodLabel: string;

    if (createPeriod === 'weekly') {
      const { start, end, label } = getLastWeekRange();
      dateFilter = (e) => {
        const d = new Date((e.check_out || '').slice(0, 10) + 'T12:00:00');
        return d >= start && d <= end;
      };
      periodLabel = label;
    } else {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const ym = lastMonth.toISOString().slice(0, 7);
      dateFilter = (e) => (e.check_out || '').slice(0, 7) === ym;
      periodLabel = lastMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    const byHost = new Map<string, CleanerEvent[]>();
    uniqueEvents
      .filter(dateFilter)
      .forEach(e => {
        if (!byHost.has(e.owner_id)) byHost.set(e.owner_id, []);
        byHost.get(e.owner_id)!.push(e);
      });

    if (byHost.size === 0) {
      Alert.alert('No Cleanings', `No cleanings found for ${periodLabel}. Invoices are generated from your schedule.`);
      return;
    }

    setCreating(true);
    let created = 0;
    for (const [hostId, events] of byHost) {
      const lineItems = events.map(e => ({
        date: (e.check_out || '').slice(0, 10),
        propertyName: e.prop_name,
        cleaningType: 'Standard Cleaning',
        rate: rates[e.prop_id] || 0,
        amount: rates[e.prop_id] || 0,
      }));
      const total = lineItems.reduce((s, li) => s + li.amount, 0);
      const result = await createInvoice({
        hostId,
        hostName: events[0].owner,
        period: periodLabel,
        lineItems,
        total,
        status: 'draft',
        event_uids: events.map(e => e.uid).filter(Boolean),
      });
      if (result) created++;
    }
    setCreating(false);
    if (created > 0) {
      Alert.alert('Created', `${created} invoice${created > 1 ? 's' : ''} created for ${periodLabel}. Tap to edit line items.`);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: 'transparent' }}>
      <View style={{ paddingHorizontal: Spacing.md, paddingTop: Spacing.md }}>
        <SwipePills
          compact
          items={[
            { key: 'Pending' as InvoiceTab, label: 'Pending' },
            { key: 'Sent' as InvoiceTab, label: 'Sent' },
            { key: 'All' as InvoiceTab, label: 'All' },
          ]}
          selected={tab}
          onSelect={handlePillSelect}
          scrollOffset={scrollX}
          pageWidth={SCREEN_W}
        />
      </View>

      <Animated.ScrollView
        ref={horizontalRef as any}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false }
        )}
        onMomentumScrollEnd={onMomentumEnd}
        decelerationRate="fast"
        style={{ flex: 1 }}
      >
        {TABS.map((tabKey) => {
          const list = tabKey === 'Pending' ? pendingInvoices : tabKey === 'Sent' ? sentInvoices : allInvoices;
          return (
            <ScrollView
              key={tabKey}
              style={{ width: SCREEN_W }}
              contentContainerStyle={styles.content}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
            >
              {error && (
                <View style={styles.errorBanner}>
                  <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
                  <Text style={styles.errorBannerText}>{error}</Text>
                </View>
              )}

              {/* Create Invoice button */}
              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.createBtn}
                onPress={() => navigation.navigate('InvoiceWizard')}
              >
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
                <Text style={styles.createBtnText}>Create Invoice</Text>
              </TouchableOpacity>

              {list.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="document-text-outline" size={48} color={Colors.textDim} />
                  <Text style={styles.emptyTitle}>
                    {tabKey === 'Pending' ? 'No pending invoices' : tabKey === 'Sent' ? 'No sent invoices' : 'No invoices yet'}
                  </Text>
                  <Text style={styles.emptyDesc}>
                    Tap "Create Invoice" to auto-generate invoices from your recent cleaning schedule.
                  </Text>
                </View>
              ) : (
                list.map(inv => (
                  <InvoiceCard
                    key={inv.id}
                    invoice={inv}
                    onSend={handleSend}
                    onDelete={handleDelete}
                    onEditLine={handleEditLine}
                    onAddLine={handleAddLine}
                    onDeleteLine={handleDeleteLine}
                  />
                ))
              )}
            </ScrollView>
          );
        })}
      </Animated.ScrollView>

      <EditLineModal
        state={editLine}
        onSave={handleSaveLine}
        onClose={() => setEditLine(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // Period selector
  periodRow: {
    flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm,
  },
  periodPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: Radius.pill,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  periodPillActive: {
    backgroundColor: Colors.greenDim, borderColor: Colors.primary,
  },
  periodPillText: { fontSize: FontSize.sm, color: Colors.textDim, fontWeight: '500' },
  periodPillTextActive: { color: Colors.primary, fontWeight: '600' },

  // Invoice card
  invoiceHeader: { flexDirection: 'row', alignItems: 'center' },
  invoiceHost: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  invoicePeriod: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  invoiceTotal: { fontSize: FontSize.lg, fontWeight: '700' },

  statusBadge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.pill,
  },
  statusText: { fontSize: FontSize.xs, fontWeight: '600' },

  // Detail
  invoiceDetail: {
    marginTop: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },

  // Line items (2-row layout)
  lineItem: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  lineItemTop: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 4,
  },
  lineDate: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  lineProp: { fontSize: FontSize.xs, color: Colors.textSecondary, flexShrink: 1 },
  lineItemBottom: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  typeTag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill,
    backgroundColor: Colors.glassDark,
  },
  typeTagTappable: {
    backgroundColor: Colors.greenDim, borderWidth: 0.5, borderColor: 'rgba(59,130,246,0.2)',
  },
  typeTagText: { fontSize: FontSize.xs, fontWeight: '500', color: Colors.text },
  lineAmount: { fontSize: FontSize.md, fontWeight: '600', color: Colors.green },

  lineTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border,
    marginTop: Spacing.xs,
  },
  lineTotalLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  lineTotalValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.green },

  // Add line item
  addLineBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, marginTop: Spacing.xs,
    borderWidth: 1, borderColor: Colors.primary, borderRadius: Radius.md,
    borderStyle: 'dashed',
  },
  addLineBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },

  // Draft actions
  draftActions: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm,
  },
  deleteBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.red,
  },
  deleteBtnText: { color: Colors.red, fontSize: FontSize.sm, fontWeight: '600' },

  sendBtn: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.green, borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
    }),
  },
  sendBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },

  // Create button
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    paddingVertical: Spacing.md, marginBottom: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  createBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Empty
  emptyState: {
    alignItems: 'center', paddingVertical: Spacing.xl * 2, paddingHorizontal: Spacing.xl,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  emptyDesc: {
    fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center',
    marginTop: Spacing.xs, lineHeight: 20,
  },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center', padding: Spacing.lg,
  },
  modalContent: {
    backgroundColor: Colors.bg, borderRadius: Radius.xl, padding: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24 },
    }),
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  modalLabel: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  modalInput: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  typePills: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs,
  },
  typePill: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.pill,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  typePillActive: {
    backgroundColor: Colors.greenDim, borderColor: Colors.primary,
  },
  typePillText: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '500' },
  typePillTextActive: { color: Colors.primary, fontWeight: '600' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  amountDollar: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  modalActions: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg,
  },
  modalCancel: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
  },
  modalCancelText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '500' },
  modalSave: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.md, backgroundColor: Colors.green,
  },
  modalSaveText: { fontSize: FontSize.md, color: '#fff', fontWeight: '600' },

  // Locked
  lockedContainer: {
    flex: 1, backgroundColor: Colors.bg,
    alignItems: 'center', justifyContent: 'center',
    padding: Spacing.xl,
  },
  lockedCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  lockedTitle: {
    fontSize: FontSize.xl, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.sm,
  },
  lockedDesc: {
    fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: Spacing.xl,
  },
  lockedBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  lockedBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  restoreLink: { marginTop: 8, padding: 8 },
  restoreLinkText: { fontSize: 12, color: Colors.primary, fontWeight: '500' },
});
