import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert,
  TextInput, Switch, Modal, ActivityIndicator, Platform, FlatList, Share, Linking, Image, KeyboardAvoidingView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { GradientHeader } from '../../components/GradientHeader';
import * as SecureStore from 'expo-secure-store';
// Lazy-load expo-clipboard to avoid crash if native module missing
const Clipboard = { setStringAsync: async (s: string) => { try { const C = require('expo-clipboard'); await C.setStringAsync(s); } catch { /* fallback */ } } };
import { useDataStore } from '../../store/dataStore';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUserStore, generatePropertyId } from '../../store/userStore';
import { apiFetch, setToken, apiDeleteAccount, apiCheckUsername, apiUpdateUsername, apiSearchUsers, apiGetFollowCode, apiFollowRequest } from '../../services/api';
import { fmt$, fmtDate } from '../../utils/format';
import { useNotificationStore } from '../../store/notificationStore';
import { PlaidLinkModal } from '../../components/PlaidLink';
import { TagPill, SPECIAL_TAGS, getPropertyColor } from '../../components/TagPill';
import { showProPaywall, type PaywallResult } from '../../components/ProPaywallModal';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { AddressAutocomplete, ResolvedAddress } from '../../components/AddressAutocomplete';
import { PropertyStreetView } from '../../components/PropertyStreetView';
import { MAPS_PROXY_URL } from '../../constants/api';

type Section = 'main' | 'properties' | 'pricelabs' | 'income' | 'plaid' | 'cleanerFeeds' | 'tagRules' | 'billing' | 'transactions' | 'invoices' | 'notifications' | 'customTags';

// ── Shared Components ──

function SettingRow({ icon, label, sub, right, onPress, labelColor, chevron = true }: {
  icon?: string; label: string; sub?: string; right?: React.ReactNode;
  onPress?: () => void; labelColor?: string; chevron?: boolean;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper onPress={onPress} activeOpacity={0.6} style={styles.row}>
      {icon && (
        <View style={[styles.rowIconWrap, labelColor === Colors.red && { backgroundColor: Colors.redDim }]}>
          <Ionicons name={icon as any} size={18} color={labelColor || Colors.primary} />
        </View>
      )}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, labelColor ? { color: labelColor } : {}]}>{label}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      {right || (chevron && onPress ? <Ionicons name="chevron-forward" size={16} color={Colors.textDim} /> : null)}
    </Wrapper>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function CardGroup({ children }: { children: React.ReactNode }) {
  return <View style={styles.cardGroup}>{children}</View>;
}

function Divider() {
  return <View style={styles.divider} />;
}

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={onPress}>
      <Ionicons name="chevron-back" size={18} color={Colors.primary} />
      <Text style={styles.backText}>Settings</Text>
    </TouchableOpacity>
  );
}

// ── Username Editor ──
function UsernameEditor({ currentUsername }: { currentUsername: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentUsername);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const setProfile = useUserStore(s => s.setProfile);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const onChangeText = (text: string) => {
    const cleaned = text.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 30);
    setValue(cleaned);
    setAvailable(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (cleaned.length < 3) { setChecking(false); return; }
    if (cleaned.toLowerCase() === currentUsername.toLowerCase()) { setAvailable(true); setChecking(false); return; }
    setChecking(true);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await apiCheckUsername(cleaned);
        setAvailable(res.available);
      } catch { setAvailable(null); }
      setChecking(false);
    }, 400);
  };

  const handleSave = async () => {
    if (!available || value.length < 3) return;
    setSaving(true);
    try {
      const res = await apiUpdateUsername(value);
      if (res.ok) {
        await setProfile({ username: res.username });
        await SecureStore.setItemAsync('pp_username', res.username);
        setEditing(false);
        Alert.alert('Updated', 'Username changed successfully.');
      }
    } catch (e: any) {
      Alert.alert('Error', e.serverError || e.message || 'Could not update username');
    }
    setSaving(false);
  };

  if (!editing) {
    return (
      <SettingRow
        icon="person-outline"
        label="Username"
        sub={currentUsername || 'Not set — tap to choose'}
        onPress={() => { setValue(currentUsername); setAvailable(null); setEditing(true); }}
      />
    );
  }

  return (
    <View style={{ padding: Spacing.md }}>
      <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 }}>USERNAME</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput
          style={{
            flex: 1, fontSize: FontSize.md, color: Colors.text,
            borderWidth: 1, borderColor: available === false ? Colors.red : available === true ? Colors.green : Colors.glassBorder,
            borderRadius: Radius.sm, paddingHorizontal: 12, paddingVertical: 10,
          }}
          value={value}
          onChangeText={onChangeText}
          placeholder="Choose a username"
          placeholderTextColor={Colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={30}
          autoFocus
        />
        {checking && <ActivityIndicator size="small" color={Colors.primary} />}
        {!checking && available === true && <Ionicons name="checkmark-circle" size={22} color={Colors.green} />}
        {!checking && available === false && <Ionicons name="close-circle" size={22} color={Colors.red} />}
      </View>
      {available === false && <Text style={{ color: Colors.red, fontSize: FontSize.xs, marginTop: 4 }}>Username is taken</Text>}
      {value.length > 0 && value.length < 3 && <Text style={{ color: Colors.textDim, fontSize: FontSize.xs, marginTop: 4 }}>Min 3 characters</Text>}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
        <TouchableOpacity activeOpacity={0.7} onPress={() => setEditing(false)}
          style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: Radius.sm, backgroundColor: Colors.glassDark }}>
          <Text style={{ color: Colors.textSecondary, fontWeight: '600', fontSize: FontSize.sm }}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} onPress={handleSave}
          disabled={!available || value.length < 3 || saving}
          style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: Radius.sm, backgroundColor: available && value.length >= 3 ? Colors.primary : Colors.glassDark, opacity: saving ? 0.6 : 1 }}>
          {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: available && value.length >= 3 ? '#fff' : Colors.textDim, fontWeight: '600', fontSize: FontSize.sm }}>Save</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Invoices Received Section ──
function InvoicesReceivedSection({ onBack }: { onBack: () => void }) {
  const fetchReceivedInvoices = useDataStore(s => s.fetchReceivedInvoices);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const invs = await fetchReceivedInvoices(true);
      setInvoices(invs);
      setLoading(false);
    })();
  }, []);

  const handleMarkPaid = async (invoiceId: string) => {
    Alert.alert('Mark as Paid', 'Confirm this invoice has been paid?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark Paid', onPress: async () => {
        setMarkingPaid(invoiceId);
        try {
          await apiFetch('/api/host/invoices/mark-paid', {
            method: 'POST',
            body: JSON.stringify({ invoice_id: invoiceId }),
          });
          setInvoices(prev => prev.map(inv =>
            inv.id === invoiceId ? { ...inv, status: 'paid' } : inv
          ));
        } catch {
          Alert.alert('Error', 'Could not mark invoice as paid');
        } finally {
          setMarkingPaid(null);
        }
      }},
    ]);
  };

  const handleShare = async (inv: any) => {
    const lines = (inv.lineItems || []).map((li: any) =>
      `  ${li.date || ''}  ${li.propertyName || ''} — ${li.cleaningType || 'Cleaning'}: $${(li.amount || 0).toFixed(2)}`
    ).join('\n');
    const text = `Invoice from ${inv.cleanerName || 'Cleaner'}\nPeriod: ${inv.period || ''}\n\n${lines}\n\nTotal: $${(inv.total || 0).toFixed(2)}\nStatus: ${inv.status || 'sent'}`;
    try { await Share.share({ message: text }); } catch {}
  };

  const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    sent: { bg: 'rgba(59,130,246,0.08)', text: Colors.primary },
    paid: { bg: 'rgba(16,185,129,0.08)', text: Colors.green },
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
      <BackButton onPress={onBack} />
      <Text style={styles.pageTitle}>Invoices Received</Text>
      <Text style={styles.pageDesc}>Invoices sent to you by your cleaners.</Text>

      {loading ? (
        <ActivityIndicator size="large" color={Colors.green} style={{ marginTop: Spacing.xl }} />
      ) : invoices.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: Spacing.xl * 2 }}>
          <Ionicons name="document-text-outline" size={48} color={Colors.textDim} />
          <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md }}>
            No invoices yet
          </Text>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs }}>
            Invoices from your cleaners will appear here.
          </Text>
        </View>
      ) : (
        invoices.map((inv: any) => {
          const statusColors = STATUS_COLORS[inv.status] || STATUS_COLORS.sent;
          const isPaid = inv.status === 'paid';
          return (
            <CardGroup key={inv.id}>
              <View style={{ padding: Spacing.md }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text }}>
                      {inv.cleanerName || 'Cleaner'}
                    </Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 }}>
                      {inv.period}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: Colors.green }}>
                      {fmt$(inv.total || 0)}
                    </Text>
                    <View style={{ backgroundColor: statusColors.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.pill }}>
                      <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: statusColors.text }}>
                        {(inv.status || 'sent').charAt(0).toUpperCase() + (inv.status || 'sent').slice(1)}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Line items */}
                {(inv.lineItems || []).map((li: any, i: number) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderTopWidth: i === 0 ? StyleSheet.hairlineWidth : 0, borderColor: Colors.border }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                        {li.date ? new Date(li.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                        {li.propertyName ? ` · ${li.propertyName}` : ''}
                      </Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textDim }}>{li.cleaningType || 'Cleaning'}</Text>
                    </View>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.green }}>{fmt$(li.amount || 0)}</Text>
                  </View>
                ))}

                {/* Total */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: Spacing.sm, borderTopWidth: 1, borderColor: Colors.border, marginTop: Spacing.xs }}>
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>Total</Text>
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.green }}>{fmt$(inv.total || 0)}</Text>
                </View>

                {/* Actions */}
                <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm }}>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: Spacing.sm, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border }}
                    onPress={() => handleShare(inv)}
                  >
                    <Ionicons name="share-outline" size={14} color={Colors.text} />
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }}>Share</Text>
                  </TouchableOpacity>
                  {!isPaid && (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: Spacing.sm, backgroundColor: Colors.green, borderRadius: Radius.md }}
                      onPress={() => handleMarkPaid(inv.id)}
                      disabled={markingPaid === inv.id}
                    >
                      {markingPaid === inv.id ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <>
                          <Ionicons name="checkmark-circle-outline" size={14} color="#fff" />
                          <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: '#fff' }}>Mark as Paid</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </CardGroup>
          );
        })
      )}
    </ScrollView>
  );
}

// ── Add Property Modal ──
function AddPropertyModal({ visible, onClose, onSave, portfolioType, editData }: {
  visible: boolean; onClose: () => void;
  onSave: (p: { name: string; address: string; units: number; isAirbnb: boolean; market?: string; icalUrl?: string; icalUrls?: string[]; lat?: number; lng?: number; unitLabels?: string[] }) => Promise<void>;
  portfolioType: 'str' | 'ltr' | 'both' | null;
  editData?: { name: string; address: string; units: number; isAirbnb: boolean; market?: string; lat?: number; lng?: number; unitLabels?: string[]; existingIcalUrls?: string[] } | null;
}) {
  const isEditing = !!editData;
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [units, setUnits] = useState('1');
  const [unitLabels, setUnitLabels] = useState<string[]>([]);
  const [isAirbnb, setIsAirbnb] = useState(portfolioType !== 'ltr');
  const [market, setMarket] = useState('');
  const [resolvedAddress, setResolvedAddress] = useState<ResolvedAddress | null>(null);
  const [icalUrls, setIcalUrls] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const unitCount = Math.max(1, parseInt(units) || 1);

  // Pre-fill fields when editing, reset when closing
  useEffect(() => {
    if (visible && editData) {
      setName(editData.name || '');
      setAddress(editData.address || '');
      setUnits(String(editData.units || 1));
      setIsAirbnb(editData.isAirbnb);
      setMarket(editData.market || '');
      setUnitLabels(editData.unitLabels || []);
      setIcalUrls(editData.existingIcalUrls || []);
      if (editData.lat) setResolvedAddress({ address: editData.address, lat: editData.lat, lng: editData.lng || 0, city: '', state: '' });
      else setResolvedAddress(null);
    } else if (!visible) {
      setName(''); setAddress(''); setUnits('1'); setUnitLabels([]);
      setIsAirbnb(portfolioType !== 'ltr'); setMarket(''); setResolvedAddress(null); setIcalUrls([]);
    }
  }, [visible, editData]);

  const handleAddressSelect = (resolved: ResolvedAddress) => {
    setResolvedAddress(resolved);
    setAddress(resolved.address);
    if (resolved.city && resolved.state) {
      setMarket(`${resolved.city}, ${resolved.state}`);
    } else if (resolved.city) {
      setMarket(resolved.city);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert('Required', 'Enter a property name'); return; }
    const trimmedIcals = icalUrls.slice(0, unitCount).map(u => (u || '').trim());
    for (const u of trimmedIcals) {
      if (u && !/^https?:\/\/.+\..+/.test(u)) {
        Alert.alert('Invalid', 'Enter a valid iCal URL starting with http:// or https://'); return;
      }
    }
    setSaving(true);
    try {
      const labels = unitCount > 1 ? unitLabels.slice(0, unitCount).map(l => l.trim()).filter(Boolean) : undefined;
      const validIcals = trimmedIcals.filter(Boolean);
      await onSave({
        name: name.trim(), address: address.trim(), units: unitCount,
        isAirbnb,
        market: market.trim() || undefined,
        ...(unitCount === 1 && validIcals[0] ? { icalUrl: validIcals[0] } : {}),
        ...(unitCount > 1 && validIcals.length ? { icalUrls: trimmedIcals } : {}),
        ...(resolvedAddress?.lat ? { lat: resolvedAddress.lat, lng: resolvedAddress.lng } : {}),
        ...(labels?.length ? { unitLabels: labels } : {}),
      });
      setName(''); setAddress(''); setUnits('1'); setUnitLabels([]); setIsAirbnb(portfolioType !== 'ltr');
      setMarket(''); setResolvedAddress(null); setIcalUrls([]); onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet"
      onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
          <View style={{ width: 36, height: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2 }} />
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: Spacing.lg, paddingBottom: Spacing.xl * 2 }}
          keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={styles.modalSectionLabel}>{isEditing ? 'EDIT PROPERTY' : 'ADD PROPERTY'}</Text>

          {/* Property Type Toggle — always visible */}
          <Text style={styles.modalFieldLabel}>Property Type</Text>
          <View style={styles.typeToggleRow}>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.typeBtn, isAirbnb && styles.typeBtnActive]} onPress={() => setIsAirbnb(true)}>
              <Ionicons name="bed-outline" size={14} color={isAirbnb ? Colors.primary : Colors.textDim}
                style={{ marginBottom: 2 }} />
              <Text style={[styles.typeBtnText, isAirbnb && styles.typeBtnTextActive]}>Airbnb / STR</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.typeBtn, !isAirbnb && styles.typeBtnActive]} onPress={() => setIsAirbnb(false)}>
              <Ionicons name="business-outline" size={14} color={!isAirbnb ? Colors.primary : Colors.textDim}
                style={{ marginBottom: 2 }} />
              <Text style={[styles.typeBtnText, !isAirbnb && styles.typeBtnTextActive]}>Long-Term Rental</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.modalFieldLabel}>Property Name *</Text>
          <TextInput style={styles.modalInput} value={name} onChangeText={setName}
            placeholder="e.g. Beach House" placeholderTextColor={Colors.textDim} autoFocus
            maxLength={100} />

          <Text style={styles.modalFieldLabel}>Address</Text>
          <AddressAutocomplete
            value={address}
            onChangeText={(t) => { setAddress(t); setResolvedAddress(null); }}
            onSelect={handleAddressSelect}
            placeholder="e.g. 123 Main St, Nashville, TN"
          />

          {/* Street View preview after address resolution */}
          {resolvedAddress && resolvedAddress.lat !== 0 && (
            <View style={{ marginTop: Spacing.sm }}>
              <PropertyStreetView lat={resolvedAddress.lat} lng={resolvedAddress.lng} height={140} />
            </View>
          )}

          {/* Auto-populated market (editable) */}
          {market ? (
            <>
              <Text style={styles.modalFieldLabel}>Market</Text>
              <TextInput style={styles.modalInput} value={market} onChangeText={setMarket}
                placeholder="e.g. Nashville, TN" placeholderTextColor={Colors.textDim} />
            </>
          ) : null}

          <View style={{ flex: 1 }}>
            <Text style={styles.modalFieldLabel}>Units</Text>
            <TextInput style={styles.modalInput} value={units}
              onChangeText={(t) => { setUnits(t); const n = parseInt(t) || 1; if (n > 1 && unitLabels.length < n) setUnitLabels(prev => [...prev, ...Array(n - prev.length).fill('')]); if (n > 1 && icalUrls.length < n) setIcalUrls(prev => [...prev, ...Array(n - prev.length).fill('')]); }}
              placeholder="1" placeholderTextColor={Colors.textDim} keyboardType="number-pad" />
          </View>

          {unitCount > 1 && (
            <View style={{ marginTop: Spacing.xs }}>
              <Text style={styles.modalFieldLabel}>Unit Labels</Text>
              <Text style={styles.modalHelpTextSmall}>
                Name each unit (e.g. 22 B, 24 B, 26 B)
              </Text>
              {Array.from({ length: unitCount }, (_, i) => (
                <View key={i} style={{ marginTop: i > 0 ? Spacing.md : 0 }}>
                  <TextInput style={styles.modalInput}
                    value={unitLabels[i] || ''}
                    onChangeText={(t) => { const updated = [...unitLabels]; updated[i] = t; setUnitLabels(updated); }}
                    placeholder={`Unit ${i + 1}`} placeholderTextColor={Colors.textDim} maxLength={50} />
                  {isAirbnb && (
                    <TextInput style={[styles.modalInput, { marginTop: Spacing.xs }]}
                      value={icalUrls[i] || ''}
                      onChangeText={(t) => { const updated = [...icalUrls]; updated[i] = t; setIcalUrls(updated); }}
                      placeholder="iCal link (optional)"
                      placeholderTextColor={Colors.textDim}
                      autoCapitalize="none" keyboardType="url" maxLength={2000} />
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Single-unit iCal link — shown for Airbnb properties with 1 unit */}
          {isAirbnb && unitCount === 1 && (
            <>
              <Text style={styles.modalFieldLabel}>iCal Link (optional)</Text>
              <Text style={styles.modalHelpTextSmall}>
                Paste your Airbnb calendar export URL to enable occupancy tracking and inventory auto-depletion.
              </Text>
              <TextInput style={styles.modalInput} value={icalUrls[0] || ''} onChangeText={(t) => setIcalUrls([t])}
                placeholder="https://www.airbnb.com/calendar/ical/..."
                placeholderTextColor={Colors.textDim}
                autoCapitalize="none" keyboardType="url" maxLength={2000} />
            </>
          )}

          <View style={styles.modalBtns}>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalCancelBtn} onPress={onClose} disabled={saving}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
          style={[styles.modalSaveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name={isEditing ? 'checkmark-circle' : 'add-circle'} size={16} color="#fff" />
                  <Text style={styles.modalSaveText}>{isEditing ? 'Save Changes' : 'Add Property'}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Add Cleaner Feed Modal ──
function AddCleanerFeedModal({ visible, onClose, properties, onSave }: {
  visible: boolean; onClose: () => void;
  properties: any[];
  onSave: (feed: { propId: string; cleanerName: string; url: string; user_id?: string; username?: string }) => void;
}) {
  const [propId, setPropId] = useState('');
  const [url, setUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ user_id: string; username: string; role: string }>>([]);
  const [selectedUser, setSelectedUser] = useState<{ user_id: string; username: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const isValidUrl = (u: string) => /^https?:\/\/.+\..+/.test(u);

  const handleSearch = (text: string) => {
    setSearchQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (text.trim().length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiSearchUsers(text.trim());
        setSearchResults(res.users || []);
      } catch { setSearchResults([]); }
      setSearching(false);
    }, 400);
  };

  const handleSelectUser = (user: { user_id: string; username: string }) => {
    setSelectedUser(user);
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleClearUser = () => {
    setSelectedUser(null);
    setSearchQuery('');
  };

  const handleSave = () => {
    if (!propId) { Alert.alert('Required', 'Select a property'); return; }
    if (!selectedUser && !searchQuery.trim()) { Alert.alert('Required', 'Search and select a cleaner'); return; }
    if (url.trim() && !isValidUrl(url.trim())) { Alert.alert('Invalid', 'Enter a valid URL starting with http:// or https://'); return; }
    const cleanerName = selectedUser?.username || searchQuery.trim();
    onSave({
      propId,
      cleanerName,
      url: url.trim(),
      ...(selectedUser ? { user_id: selectedUser.user_id, username: selectedUser.username } : {}),
    });
    setPropId(''); setUrl(''); setSearchQuery(''); setSelectedUser(null); setSearchResults([]); onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalCard}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalSectionLabel}>ADD CLEANER</Text>
          <Text style={styles.inputLabel}>Property</Text>
          <View style={styles.propPillRow}>
            {properties.map(p => (
              <TouchableOpacity activeOpacity={0.7}
          key={p.id} style={[styles.propPill, propId === p.id && styles.propPillActive]}
                onPress={() => setPropId(p.id)}>
                <Text style={[styles.propPillText, propId === p.id && styles.propPillTextActive]}>{p.label || p.id}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.inputLabel}>Search Cleaner</Text>
          {selectedUser ? (
            <View style={styles.selectedUserChip}>
              <Ionicons name="person-circle-outline" size={18} color={Colors.primary} />
              <Text style={styles.selectedUserText}>@{selectedUser.username}</Text>
              <TouchableOpacity activeOpacity={0.7} onPress={handleClearUser} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={18} color={Colors.textDim} />
              </TouchableOpacity>
            </View>
          ) : (
            <View>
              <TextInput style={styles.modalInput} value={searchQuery} onChangeText={handleSearch}
                placeholder="Search by username or email" placeholderTextColor={Colors.textDim} autoFocus
                autoCapitalize="none" maxLength={100} />
              {searching && <ActivityIndicator size="small" color={Colors.primary} style={{ marginTop: 4 }} />}
              {searchResults.length > 0 && (
                <View style={styles.searchResultsList}>
                  {searchResults.map(user => (
                    <TouchableOpacity activeOpacity={0.7} key={user.user_id} style={styles.searchResultRow}
                      onPress={() => handleSelectUser(user)}>
                      <Ionicons name="person-circle-outline" size={22} color={Colors.primary} />
                      <Text style={styles.searchResultName}>@{user.username}</Text>
                      {user.role === 'cleaner' && (
                        <View style={styles.roleBadge}><Text style={styles.roleBadgeText}>Cleaner</Text></View>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          )}
          <Text style={styles.inputLabel}>Calendar URL (optional)</Text>
          <TextInput style={styles.modalInput} value={url} onChangeText={setUrl}
            placeholder="iCal or Google Calendar link" placeholderTextColor={Colors.textDim}
            autoCapitalize="none" keyboardType="url" maxLength={2000} />
          <View style={styles.modalBtns}>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalCancelBtn} onPress={onClose}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalSaveBtn} onPress={handleSave}>
              <Ionicons name="add-circle" size={16} color="#fff" />
              <Text style={styles.modalSaveText}>Add Cleaner</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Legal Content Modal ──
// Legal pages now open externally via Linking.openURL (Apple requirement)

// ── Add Tag Rule Modal ──
function AddTagRuleModal({ visible, onClose, properties, onSave }: {
  visible: boolean; onClose: () => void;
  properties: any[]; onSave: (rule: { payee: string; propId: string }) => void;
}) {
  const [payee, setPayee] = useState('');
  const [propId, setPropId] = useState('');

  const handleSave = () => {
    if (!payee.trim()) { Alert.alert('Required', 'Enter a payee name'); return; }
    if (!propId) { Alert.alert('Required', 'Select a tag'); return; }
    onSave({ payee: payee.trim().toUpperCase(), propId });
    setPayee(''); setPropId(''); onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalCard}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalSectionLabel}>ADD TAG RULE</Text>
          <Text style={styles.modalHelpText}>
            Transactions from this payee will be automatically tagged to the selected category.
          </Text>
          <Text style={styles.inputLabel}>Payee / Merchant Name</Text>
          <TextInput style={styles.modalInput} value={payee} onChangeText={setPayee}
            placeholder="e.g. HOUSTON ELECTRIC" placeholderTextColor={Colors.textDim}
            autoCapitalize="characters" autoFocus />
          <Text style={styles.inputLabel}>Assign Tag</Text>
          <View style={styles.tagPillGrid}>
            {properties.map((p, i) => (
              <TagPill key={p.id} tagId={p.id} label={p.label || p.id}
                propertyIndex={i} selected={propId === p.id}
                onPress={() => setPropId(p.id)} size="md" />
            ))}
            {Object.keys(SPECIAL_TAGS).map(key => (
              <TagPill key={key} tagId={key} selected={propId === key}
                onPress={() => setPropId(key)} size="md" />
            ))}
          </View>
          <View style={styles.modalBtns}>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalCancelBtn} onPress={onClose}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalSaveBtn} onPress={handleSave}>
              <Ionicons name="add-circle" size={16} color="#fff" />
              <Text style={styles.modalSaveText}>Add Rule</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Manual Income Modal ──
// Adapts based on portfolio type:
// - STR only → "Airbnb Income" (lump sum, no per-property)
// - LTR only → Per-property income selection
// - Both → Two modes: "Airbnb Income" (lump) or per non-Airbnb property
function ManualIncomeModal({ visible, onClose, properties, portfolioType, onSave }: {
  visible: boolean; onClose: () => void;
  properties: any[];
  portfolioType: 'str' | 'ltr' | 'both' | null;
  onSave: (entry: { propId: string; amount: string; description: string; date: string; incomeType: string }) => void;
}) {
  const [incomeType, setIncomeType] = useState<'airbnb' | 'property'>('airbnb');
  const [propId, setPropId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  const isSTR = portfolioType === 'str';
  const isLTR = portfolioType === 'ltr';
  const isBoth = portfolioType === 'both' || !portfolioType;

  // Non-Airbnb properties only
  const nonAirbnbProps = properties.filter(p => !p.isAirbnb);

  const handleSave = () => {
    const parsed = parseFloat(amount);
    if (!amount.trim() || isNaN(parsed) || parsed <= 0) {
      Alert.alert('Required', 'Enter a valid positive amount'); return;
    }
    if (parsed > 1000000) {
      Alert.alert('Invalid', 'Amount seems too large. Please check and try again.'); return;
    }

    // For LTR or "property" mode in Both, require a property
    if ((isLTR || incomeType === 'property') && !propId) {
      Alert.alert('Required', 'Select a property'); return;
    }

    onSave({
      propId: (isSTR || incomeType === 'airbnb') ? 'airbnb' : propId,
      amount: amount.trim(),
      description: description.trim() || ((isSTR || incomeType === 'airbnb') ? 'Airbnb income' : ''),
      date: new Date().toISOString().slice(0, 10),
      incomeType: (isSTR || incomeType === 'airbnb') ? 'airbnb' : 'property',
    });
    setPropId(''); setAmount(''); setDescription(''); setIncomeType('airbnb'); onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalCard}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalSectionLabel}>ADD MANUAL INCOME</Text>

          {/* Income type toggle — only show for "Both" portfolio */}
          {isBoth && (
            <>
              <Text style={styles.inputLabel}>Income Type</Text>
              <View style={styles.typeToggleRow}>
                <TouchableOpacity activeOpacity={0.7}
          style={[styles.typeBtn, incomeType === 'airbnb' && styles.typeBtnActive]}
                  onPress={() => { setIncomeType('airbnb'); setPropId(''); }}
                >
                  <Text style={[styles.typeBtnText, incomeType === 'airbnb' && styles.typeBtnTextActive]}>Airbnb Income</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
          style={[styles.typeBtn, incomeType === 'property' && styles.typeBtnActive]}
                  onPress={() => setIncomeType('property')}
                >
                  <Text style={[styles.typeBtnText, incomeType === 'property' && styles.typeBtnTextActive]}>Non-Airbnb</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* STR-only: show Airbnb label */}
          {isSTR && (
            <View style={styles.incomeTypeLabel}>
              <View style={[styles.incomeTypeDot, { backgroundColor: Colors.primary }]} />
              <Text style={styles.incomeTypeLabelText}>Airbnb Income (total deposit)</Text>
            </View>
          )}

          {/* LTR or "property" mode: show property selector */}
          {(isLTR || (isBoth && incomeType === 'property')) && (
            <>
              <Text style={styles.inputLabel}>Property</Text>
              <View style={styles.propPillRow}>
                {(isLTR ? properties : nonAirbnbProps).map(p => (
                  <TouchableOpacity activeOpacity={0.7}
          key={p.id} style={[styles.propPill, propId === p.id && styles.propPillActive]}
                    onPress={() => setPropId(p.id)}>
                    <Text style={[styles.propPillText, propId === p.id && styles.propPillTextActive]}>{p.label || p.id}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {/* "Airbnb" mode: show info note */}
          {(isSTR || (isBoth && incomeType === 'airbnb')) && (
            <Text style={styles.modalHelpText}>
              Enter the total Airbnb direct deposit amount. Airbnb deposits are not split per-property.
            </Text>
          )}

          <Text style={styles.inputLabel}>Amount ($)</Text>
          <TextInput style={styles.modalInput} value={amount} onChangeText={setAmount}
            placeholder="0.00" placeholderTextColor={Colors.textDim} keyboardType="decimal-pad"
            maxLength={10} />

          <Text style={styles.inputLabel}>Description (optional)</Text>
          <TextInput style={styles.modalInput} value={description} onChangeText={setDescription}
            maxLength={200}
            placeholder={
              (isSTR || (isBoth && incomeType === 'airbnb'))
                ? 'e.g. March payout, Bi-weekly deposit'
                : 'e.g. March rent, Security deposit'
            }
            placeholderTextColor={Colors.textDim} />

          <View style={styles.modalBtns}>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalCancelBtn} onPress={onClose}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.modalSaveBtn} onPress={handleSave}>
              <Ionicons name="add-circle" size={16} color="#fff" />
              <Text style={styles.modalSaveText}>Add Income</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Tab Order Labels ──

const PILL_LABELS: Record<string, string> = {
  profile: 'HQ', home: 'Overview', performance: 'Performance', projections: 'Projections',
  calendar: 'Calendar', cleanings: 'Cleanings', inventory: 'Inventory',
  schedule: 'Schedule', owners: 'Hosts', invoices: 'Invoices', money: 'Money',
};

// ══════════════════════════════════════
// ── Main Settings Screen ──
// ══════════════════════════════════════
export function SettingsScreen() {
  const invalidateAll = useDataStore(s => s.invalidateAll);
  const fetchProps = useDataStore(s => s.fetchProps);
  const fetchCustomCategoriesApi = useDataStore(s => s.fetchCustomCategories);
  const saveCustomCategoryApi = useDataStore(s => s.saveCustomCategory);
  const deleteCustomCategoryApi = useDataStore(s => s.deleteCustomCategory);
  const resetOnboarding = useOnboardingStore(s => s.reset);
  const portfolioType = useOnboardingStore(s => s.portfolioType);
  const clearUserStore = useUserStore(s => s.clearAll);
  const activateData = useUserStore(s => s.activateData);
  const userProfile = useUserStore(s => s.profile);
  const setUserProfile = useUserStore(s => s.setProfile);
  const isLTR = userProfile?.portfolioType === 'ltr';
  const isSTR = userProfile?.portfolioType === 'str' || userProfile?.portfolioType === 'both';
  const fetchFollowCode = useUserStore(s => s.fetchFollowCode);
  const [followCodeValue, setFollowCodeValue] = useState<string | null>(null);

  const [section, setSection] = useState<Section>('main');
  const [properties, setProperties] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showAddProp, setShowAddProp] = useState(false);
  const [editingPropIndex, setEditingPropIndex] = useState<number | null>(null);
  const [editingUnitsPerYear, setEditingUnitsPerYear] = useState(false);
  const [unitsPerYearDraft, setUnitsPerYearDraft] = useState('');
  const [showAddIncome, setShowAddIncome] = useState(false);
  const [showAddCleaner, setShowAddCleaner] = useState(false);
  const [showAddTagRule, setShowAddTagRule] = useState(false);
  const [icalFeeds, setIcalFeeds] = useState<any[]>([]);
  const [cleanerFeeds, setCleanerFeeds] = useState<any[]>([]);
  const [tagRules, setTagRules] = useState<Record<string, string>>({});
  const [customCategories, setCustomCategories] = useState<any[]>([]);
  const [customTagName, setCustomTagName] = useState('');
  const [customTagType, setCustomTagType] = useState<'income' | 'expense'>('expense');
  const [priceLabsKey, setPriceLabsKey] = useState('');
  const [plaidAccounts, setPlaidAccounts] = useState<any[]>([]);
  const [plaidLinkToken, setPlaidLinkToken] = useState('');
  const [showPlaidLink, setShowPlaidLink] = useState(false);
  // Legal links open externally (Apple requirement)


  // Referral state
  const [referredBy, setReferredBy] = useState<string | null>(null);

  // Privacy state
  const [isPrivate, setIsPrivate] = useState(false);

  const { isActive: billingActive, isReadOnly, isFounder, lifetimeFree } = useSubscriptionGate();
  const checkout = useProCheckout();
  const fetchBillingStatus = useUserStore(s => s.fetchBillingStatus);

  const notifPrefs = useNotificationStore(s => s.preferences);
  const updateNotifPrefs = useNotificationStore(s => s.updatePreferences);
  const fetchNotifPrefs = useNotificationStore(s => s.fetchPreferences);

  const [notifyNewTx, setNotifyNewTx] = useState(true);
  const [autoSync, setAutoSync] = useState(true);

  // Transactions sub-screen state
  const fetchTransactions = useDataStore(s => s.fetchTransactions);
  const [allTransactions, setAllTransactions] = useState<any[]>([]);
  const [txSearch, setTxSearch] = useState('');
  const [txEditingId, setTxEditingId] = useState<string | null>(null);
  const [txEditFields, setTxEditFields] = useState<Record<string, string>>({});
  const [txSaving, setTxSaving] = useState(false);
  const [txLoading, setTxLoading] = useState(false);

  // ── Pro gate: present custom paywall ──
  const handleProGate = async () => {
    try {
      if (Platform.OS === 'ios') {
        const result = await showProPaywall();
        if (result === 'purchased' || result === 'restored') {
          await fetchBillingStatus();
        }
      } else {
        const plan = userProfile?.accountType === 'cleaner' ? 'cleaner_pro_monthly' : 'pp_pro_monthly';
        const res = await apiFetch('/api/billing/create-checkout', {
          method: 'POST', body: JSON.stringify({ plan }),
        });
        if (res.checkout_url) {
          setCheckoutSessionId(res.session_id || '');
          setCheckoutUrl(res.checkout_url);
          setShowCheckout(true);
        } else {
          Alert.alert('Error', 'Could not start checkout.');
        }
      }
    } catch {
      if (Platform.OS !== 'ios') Alert.alert('Error', 'Could not connect to billing.');
    }
  };

  useEffect(() => {
    loadData();
    fetchNotifPrefs();
    if (isSTR && userProfile?.accountType !== 'cleaner') {
      fetchFollowCode().then(code => { if (code) setFollowCodeValue(code); });
    }
  }, []);

  const loadData = async () => {
    setLoading(true);
    // Properties come from local userStore profile, not API
    setProperties(userProfile?.properties || []);
    try { const tags = await apiFetch('/api/tags'); setTagRules(tags || {}); } catch { }
    try {
      const data = await apiFetch('/api/ical/feeds');
      setIcalFeeds(Array.isArray(data) ? data : (data?.feeds || []));
    } catch { setIcalFeeds([]); }
    try {
      const data = await apiFetch('/api/cleaner/feeds');
      setCleanerFeeds(Array.isArray(data) ? data : (data?.feeds || []));
    } catch { setCleanerFeeds([]); }
    try {
      const data = await apiFetch('/api/plaid/accounts');
      const accounts = Array.isArray(data) ? data : (data?.accounts || []);
      setPlaidAccounts(accounts);
      // Backfill plaidConnected for users who connected before this flag existed
      if (accounts.length > 0 && !userProfile?.plaidConnected) {
        await setUserProfile({ plaidConnected: true });
      }
    } catch { setPlaidAccounts([]); }
    try {
      const cats = await fetchCustomCategoriesApi(true);
      setCustomCategories(cats);
    } catch { setCustomCategories([]); }
    // Fetch referral data
    try {
      const ref = await apiFetch('/api/referral/code');
      setReferredBy(ref.referred_by || null);
    } catch { }
    setLoading(false);
  };

  // ── Transactions handlers ──

  const loadTransactions = async () => {
    setTxLoading(true);
    try {
      const txs = await fetchTransactions(true);
      const sorted = [...txs].sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
      setAllTransactions(sorted);
    } catch { setAllTransactions([]); }
    setTxLoading(false);
  };

  const startTxEdit = (t: any) => {
    if (txEditingId === t.id) {
      setTxEditingId(null);
      setTxEditFields({});
      return;
    }
    setTxEditingId(t.id);
    setTxEditFields({
      amount: String(Math.abs(t.amount ?? 0)),
      name: t.name || t.merchant || t.description || '',
      date: t.date || '',
      category: t.category || '',
      property_tag: t.property_tag || '',
    });
  };

  const isValidDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

  const handleTxSave = async () => {
    if (!txEditingId) return;
    const txName = (txEditFields.name || '').trim();
    const txDate = (txEditFields.date || '').trim();
    const txAmount = parseFloat(txEditFields.amount || '0');
    if (!txName) { Alert.alert('Required', 'Enter a transaction name'); return; }
    if (!txDate || !isValidDate(txDate)) { Alert.alert('Invalid', 'Enter a valid date in YYYY-MM-DD format'); return; }
    if (isNaN(txAmount)) { Alert.alert('Invalid', 'Enter a valid amount'); return; }
    setTxSaving(true);
    try {
      const tx = allTransactions.find((t: any) => t.id === txEditingId);
      if (!tx) return;
      const isExpense = (tx.amount ?? 0) < 0;
      const newAmount = parseFloat(txEditFields.amount || '0');
      const finalAmount = isExpense ? -Math.abs(newAmount) : Math.abs(newAmount);

      await apiFetch('/api/transactions/update', {
        method: 'POST',
        body: JSON.stringify({
          id: txEditingId,
          amount: finalAmount,
          name: txEditFields.name,
          date: txEditFields.date,
          category: txEditFields.category,
          property_tag: txEditFields.property_tag || null,
        }),
      });

      setTxEditingId(null);
      setTxEditFields({});
      invalidateAll();
      await loadTransactions();
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not save changes.');
    } finally { setTxSaving(false); }
  };

  // ── Handlers ──

  const handleSync = async () => {
    if (plaidAccounts.length === 0) {
      Alert.alert('No Accounts', 'Connect a bank account through Plaid first to sync transactions.');
      return;
    }
    setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      await activateData();
      invalidateAll();
      Alert.alert('Synced', 'Transactions synced successfully.');
    } catch (e: any) {
      Alert.alert('Sync Error', e?.serverError || e?.message || 'Could not sync transactions. Please try again.');
    }
    finally { setSyncing(false); }
  };

  const handleRefreshAll = () => {
    invalidateAll();
    Alert.alert('Cache Cleared', 'Data will reload on next visit to each tab.');
  };

  const handleAddProperty = async (p: { name: string; address: string; units: number; isAirbnb: boolean; market?: string; icalUrl?: string; icalUrls?: string[]; lat?: number; lng?: number; unitLabels?: string[] }) => {
    const currentProps = userProfile?.properties || [];
    if (isReadOnly && currentProps.length >= 2) {
      handleProGate();
      return;
    }
    const id = generatePropertyId(p.name);
    const newProp = {
      id, label: p.name, name: p.name, address: p.address, units: p.units, isAirbnb: p.isAirbnb,
      ...(p.market ? { market: p.market } : {}),
      ...(p.lat ? { lat: p.lat, lng: p.lng } : {}),
      ...(p.unitLabels?.length ? { unitLabels: p.unitLabels } : {}),
    };
    const updatedProps = [...currentProps, newProp];
    await setUserProfile({ properties: updatedProps });
    setProperties(updatedProps);
    // Sync to backend
    try {
      await apiFetch('/api/props', { method: 'POST', body: JSON.stringify({ props: updatedProps }) });
    } catch {}
    // Save iCal feeds (single or per-unit)
    const allIcals: { url: string; unitLabel?: string }[] = [];
    if (p.icalUrl) {
      allIcals.push({ url: p.icalUrl });
    } else if (p.icalUrls) {
      p.icalUrls.forEach((u, i) => {
        if (u) allIcals.push({ url: u, unitLabel: p.unitLabels?.[i] || `Unit ${i + 1}` });
      });
    }
    if (allIcals.length) {
      try {
        const newFeeds = allIcals.map(ic => ({
          propId: id,
          listingName: ic.unitLabel ? `${p.name} - ${ic.unitLabel}` : p.name,
          url: ic.url,
        }));
        const updatedFeeds = [...icalFeeds, ...newFeeds];
        await apiFetch('/api/ical/feeds', { method: 'POST', body: JSON.stringify({ feeds: updatedFeeds }) });
        setIcalFeeds(updatedFeeds);
        // Trigger sync so events appear immediately
        try { await apiFetch('/api/ical/sync', { method: 'POST' }); } catch {}
        invalidateAll();
      } catch {}
    }
    // Auto-upgrade portfolioType when mixing property types
    const currentType = portfolioType;
    const hasAirbnb = updatedProps.some((prop: any) => prop.isAirbnb);
    const hasNonAirbnb = updatedProps.some((prop: any) => !prop.isAirbnb);
    let upgraded = false;
    if (hasAirbnb && hasNonAirbnb && currentType !== 'both') {
      await useOnboardingStore.getState().setPortfolioType('both');
      await setUserProfile({ portfolioType: 'both' });
      upgraded = true;
    } else if (hasAirbnb && !hasNonAirbnb && currentType === 'ltr') {
      await useOnboardingStore.getState().setPortfolioType('str');
      await setUserProfile({ portfolioType: 'str' });
      upgraded = true;
    } else if (!hasAirbnb && hasNonAirbnb && currentType === 'str') {
      await useOnboardingStore.getState().setPortfolioType('ltr');
      await setUserProfile({ portfolioType: 'ltr' });
      upgraded = true;
    }
    if (upgraded && p.isAirbnb && (currentType === 'ltr')) {
      Alert.alert(
        'Dashboard Updated',
        'Your dashboard now includes Airbnb features like occupancy tracking, calendar sync, and inventory auto-depletion. You can manage all property types from one place.',
      );
    } else if (upgraded && !p.isAirbnb && (currentType === 'str')) {
      Alert.alert(
        'Dashboard Updated',
        'Your dashboard now supports both short-term and long-term rental properties.',
      );
    }
    await activateData();
  };

  const handleDeleteProperty = (indexStr: string, label: string) => {
    const currentProps = userProfile?.properties || [];
    const idx = parseInt(indexStr, 10);
    const prop = currentProps[idx];
    const propId = prop?.id || prop?.name;

    Alert.alert(
      'Delete Property',
      `Deleting "${label}" will permanently remove all associated data including units, iCal feeds, calendar events, transaction tags, inventory, and P&L history.\n\nThis cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete All Data', style: 'destructive', onPress: async () => {
          try {
            // Backend cascade delete — removes feeds, events, tags, inventory, etc.
            if (propId) {
              try {
                await useDataStore.getState().deleteProperty(propId);
              } catch {
                // Backend may not support cascade delete yet — continue with local delete
                useDataStore.getState().invalidateAll();
              }
            }
            // Remove from local profile
            const updatedProps = currentProps.filter((_, i) => i !== idx);
            await setUserProfile({ properties: updatedProps });
            setProperties(updatedProps);
          } catch (e: any) {
            Alert.alert('Error', e.message || 'Could not delete property. Please try again.');
          }
        }},
      ],
    );
  };

  const handleSavePriceLabs = async () => {
    if (!priceLabsKey.trim()) { Alert.alert('Required', 'Enter your PriceLabs API key'); return; }
    try {
      await apiFetch('/api/pricelabs/config', { method: 'POST', body: JSON.stringify({ api_key: priceLabsKey.trim() }) });
      await activateData();
      Alert.alert('Saved', 'PriceLabs API key saved.');
    } catch { Alert.alert('Error', 'Could not save API key. Please try again.'); }
  };

  const handleAddManualIncome = async (entry: { propId: string; amount: string; description: string; date: string; incomeType: string }) => {
    try {
      await apiFetch('/api/income/manual', { method: 'POST', body: JSON.stringify(entry) });
      await activateData();
      invalidateAll();
      Alert.alert('Added', `$${entry.amount} income added.`);
    } catch { Alert.alert('Error', 'Could not save income entry. Please try again.'); }
  };

  const handleSaveCleanerFeed = async (feed: { propId: string; cleanerName: string; url: string; user_id?: string; username?: string }) => {
    try {
      const feedEntry: any = { name: feed.cleanerName, url: feed.url, propId: feed.propId };
      if (feed.user_id) feedEntry.user_id = feed.user_id;
      if (feed.username) feedEntry.username = feed.username;
      const updated = [...cleanerFeeds, feedEntry];
      await apiFetch('/api/cleaner/feeds', { method: 'POST', body: JSON.stringify({ feeds: updated }) });
      setCleanerFeeds(updated);
      // Send follow request if a user was selected (triggers notification)
      if (feed.username) {
        try { await apiFollowRequest(feed.username); } catch { /* follow may already exist */ }
      }
      Alert.alert('Saved', 'Cleaner added.');
    } catch { Alert.alert('Error', 'Could not save cleaner. Please try again.'); }
  };

  const handleDeleteCleanerFeed = (idx: number) => {
    Alert.alert('Remove Cleaner', 'Remove this cleaner feed?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        const updated = cleanerFeeds.filter((_, i) => i !== idx);
        try { await apiFetch('/api/cleaner/feeds', { method: 'POST', body: JSON.stringify({ feeds: updated }) }); setCleanerFeeds(updated); }
        catch { setCleanerFeeds(updated); }
      }},
    ]);
  };

  const handleAddTagRule = async (rule: { payee: string; propId: string }) => {
    try {
      await apiFetch('/api/tags/rule', { method: 'POST', body: JSON.stringify(rule) });
      setTagRules(prev => ({ ...prev, [rule.payee]: rule.propId }));
      Alert.alert('Saved', `Transactions from "${rule.payee}" will auto-tag to this property.`);
    } catch { Alert.alert('Error', 'Could not save tag rule. Please try again.'); }
  };

  const handleDeleteTagRule = (payee: string) => {
    Alert.alert('Delete Rule', `Remove auto-tag rule for "${payee}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await apiFetch('/api/tags/rule', { method: 'DELETE', body: JSON.stringify({ payee }) });
          setTagRules(prev => { const u = { ...prev }; delete u[payee]; return u; });
        } catch { setTagRules(prev => { const u = { ...prev }; delete u[payee]; return u; }); }
      }},
    ]);
  };

  const handleConnectPlaid = async () => {
    if (isReadOnly) {
      const result = await checkout.startCheckout();
      if (result !== 'purchased' && result !== 'restored') return;
    }
    setSyncing(true);
    try {
      const res = await apiFetch('/api/create-link-token', { method: 'POST' });
      if (res.link_token) {
        setPlaidLinkToken(res.link_token);
        setShowPlaidLink(true);
      } else {
        Alert.alert('Error', res.error || 'Could not create Plaid link token.');
      }
    } catch {
      Alert.alert('Connection Error', 'Could not connect to Plaid. Please try again later.');
    } finally {
      setSyncing(false);
    }
  };

  const handlePlaidSuccess = async (publicToken: string, accountName: string) => {
    setShowPlaidLink(false);
    setSyncing(true);
    try {
      const result = await apiFetch('/api/exchange-token', {
        method: 'POST',
        body: JSON.stringify({ public_token: publicToken, account_name: accountName }),
      });
      if (result?.item_id) {
        try { await apiFetch('/api/transactions/historical', { method: 'POST', body: JSON.stringify({ item_id: result.item_id }) }); } catch { /* ok */ }
      }
      try { await apiFetch('/api/transactions/sync', { method: 'POST' }); } catch { /* ok */ }
      await setUserProfile({ plaidConnected: true });
      await activateData();
      invalidateAll();
      loadData();
      Alert.alert('Connected', `${accountName} connected successfully.`);
    } catch {
      Alert.alert('Error', 'Could not complete bank connection. Please try again.');
    } finally {
      setSyncing(false);
    }
  };

  const handlePlaidExit = (error?: any) => {
    setShowPlaidLink(false);
    if (error?.error_message) {
      Alert.alert('Plaid', error.error_message);
    }
  };

  const handleRemovePlaidAccount = (itemId: string, name: string) => {
    Alert.alert('Remove Account', `Disconnect "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        try { await apiFetch(`/api/plaid/accounts/${itemId}`, { method: 'DELETE' }); }
        catch { /* ok */ }
        loadData();
      }},
    ]);
  };

  const handleResetOnboarding = () => {
    Alert.alert('Reset Onboarding', 'This will show the welcome screen again on next launch.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: resetOnboarding },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert('Delete Account', 'This will permanently delete all your data. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        // 1. Delete account on server
        try { await apiDeleteAccount(); } catch { /* continue with local cleanup */ }
        // 2. Clear all Zustand in-memory data cache
        invalidateAll();
        // 3. Clear user profile + reset API token
        await clearUserStore();
        setToken(null);
        // 4. Clear ALL SecureStore keys
        await Promise.all([
          SecureStore.deleteItemAsync('pp_user_profile'),
          SecureStore.deleteItemAsync('pp_token'),
          SecureStore.deleteItemAsync('pp_biometric'),
          SecureStore.deleteItemAsync('pp_onboarding_complete'),
          SecureStore.deleteItemAsync('pp_portfolio_type'),
          SecureStore.deleteItemAsync('pp_email'),
        ]);
        // 5. Reset onboarding → triggers full app re-render to LandingScreen
        await resetOnboarding();
      }},
    ]);
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', "You'll need to sign in again to access your account.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: async () => {
        // Save email before wiping profile so it can be restored on sign in
        const email = userProfile?.email;
        if (email) {
          await SecureStore.setItemAsync('pp_email', email);
        }
        // Clear data store cache
        invalidateAll();
        // Wipe user profile + reset API token
        await clearUserStore();
        setToken(null);
        // Delete session/preference keys but keep portfolio type + email for re-sign-in
        await Promise.all([
          SecureStore.deleteItemAsync('pp_onboarding_complete'),
          SecureStore.deleteItemAsync('pp_user_profile'),
          SecureStore.deleteItemAsync('pp_token'),
          SecureStore.deleteItemAsync('pp_biometric'),
        ]);
        // Trigger Landing screen
        useOnboardingStore.setState({ hasCompleted: false });
      }},
    ]);
  };

  // ═══════════════════════════════
  // ── SUB-SECTIONS ──
  // ═══════════════════════════════

  if (section === 'properties') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Properties</Text>
        <Text style={styles.pageDesc}>Manage your rental properties. Properties determine how transactions are categorized.</Text>
        <CardGroup>
          {properties.length === 0 ? (
            <View style={styles.emptyRow}><Text style={styles.emptyText}>No properties yet — add your first one below</Text></View>
          ) : properties.map((p: any, i) => {
            const label = p.name || p.label || p.id || 'Property';
            return (
            <React.Fragment key={label + i}>
              <View style={styles.propRow}>
                {p.lat && p.lng ? (
                  <Image
                    source={{ uri: `${MAPS_PROXY_URL}/api/streetview?lat=${p.lat}&lng=${p.lng}&width=96&height=96` }}
                    style={{ width: 48, height: 48, borderRadius: Radius.sm, marginRight: Spacing.sm }}
                  />
                ) : (
                  <View style={{ width: 48, height: 48, borderRadius: Radius.sm, marginRight: Spacing.sm, backgroundColor: Colors.glassDark, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="home-outline" size={20} color={Colors.textDim} />
                  </View>
                )}
                <View style={styles.propInfo}>
                  <Text style={styles.propName}>{label}</Text>
                  <Text style={styles.propType}>
                    {p.units} {p.units === 1 ? 'unit' : 'units'} · {p.isAirbnb ? 'STR' : 'LTR'}
                    {(() => { const feedCount = icalFeeds.filter((f: any) => f.propId === (p.id || p.name)).length; return feedCount > 0 ? ` · ${feedCount} iCal` : ''; })()}
                  </Text>
                </View>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setEditingPropIndex(i)}
                  style={{ marginRight: Spacing.sm }}>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '500', color: Colors.primary }}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => handleDeleteProperty(String(i), label)}>
                  <Text style={styles.deleteText}>Delete</Text>
                </TouchableOpacity>
              </View>
              {i < properties.length - 1 && <Divider />}
            </React.Fragment>
            );
          })}
        </CardGroup>
        {isReadOnly && properties.length >= 2 ? (
          <TouchableOpacity activeOpacity={0.7}
            style={[styles.addBtn, { borderColor: Colors.primary + '40' }]} onPress={handleProGate} disabled={syncing}>
            <Ionicons name="diamond-outline" size={16} color={Colors.primary} />
            <Text style={[styles.addBtnText, { color: Colors.primary }]}>
              {syncing ? 'Loading...' : 'Subscribe to Add More'}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity activeOpacity={0.7}
            style={styles.addBtn} onPress={() => setShowAddProp(true)}>
            <Ionicons name="add" size={18} color={Colors.primary} />
            <Text style={styles.addBtnText}>Add Property</Text>
          </TouchableOpacity>
        )}

        <SectionTitle title="Growth Plan" />
        <CardGroup>
          <View style={styles.inputRow}>
            <Text style={styles.rowLabel}>Units to acquire per year</Text>
            <Text style={styles.rowSub}>Used to calculate future year projections</Text>
            {editingUnitsPerYear ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm }}>
                <TextInput
                  style={[styles.settingsInput, { flex: 1 }]}
                  value={unitsPerYearDraft}
                  onChangeText={setUnitsPerYearDraft}
                  placeholder="e.g. 2"
                  placeholderTextColor={Colors.textDim}
                  keyboardType="number-pad"
                  autoFocus
                />
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={{ backgroundColor: Colors.primary, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2 }}
                  onPress={() => {
                    const num = unitsPerYearDraft === '' ? undefined : parseInt(unitsPerYearDraft) || 0;
                    setUserProfile({ unitsPerYear: num });
                    setEditingUnitsPerYear(false);
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: FontSize.sm, fontWeight: '600' }}>Save</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm,
                  backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Spacing.md }}
                onPress={() => {
                  setUnitsPerYearDraft(String(userProfile?.unitsPerYear ?? ''));
                  setEditingUnitsPerYear(true);
                }}
              >
                <Text style={{ fontSize: FontSize.md, color: userProfile?.unitsPerYear ? Colors.text : Colors.textDim, fontWeight: '500' }}>
                  {userProfile?.unitsPerYear ? `${userProfile.unitsPerYear} units/year` : 'Not set'}
                </Text>
                <Ionicons name="pencil" size={14} color={Colors.textDim} />
              </TouchableOpacity>
            )}
          </View>
        </CardGroup>

        <AddPropertyModal visible={showAddProp} onClose={() => setShowAddProp(false)} onSave={handleAddProperty} portfolioType={portfolioType} />
        <AddPropertyModal
          visible={editingPropIndex !== null}
          onClose={() => setEditingPropIndex(null)}
          portfolioType={portfolioType}
          editData={editingPropIndex !== null ? (() => {
            const prop = properties[editingPropIndex];
            const propId = prop.id || prop.name;
            const propFeeds = icalFeeds.filter((f: any) => f.propId === propId);
            // Build iCal URLs array aligned with unit labels
            const existingIcalUrls: string[] = [];
            if (prop.units > 1 && prop.unitLabels?.length) {
              prop.unitLabels.forEach((label: string) => {
                const feed = propFeeds.find((f: any) =>
                  f.listingName === `${prop.name} - ${label}` || f.url
                );
                const matchedFeed = propFeeds.find((f: any) =>
                  f.listingName?.includes(label)
                );
                existingIcalUrls.push(matchedFeed?.url || '');
              });
            } else if (propFeeds.length > 0) {
              existingIcalUrls.push(propFeeds[0].url || '');
            }
            return { ...prop, existingIcalUrls };
          })() : null}
          onSave={async (p) => {
            if (editingPropIndex === null) return;
            const currentProps = [...(userProfile?.properties || [])];
            const existing = currentProps[editingPropIndex];
            const propId = existing.id || existing.name;
            const oldName = existing.name;
            currentProps[editingPropIndex] = {
              ...existing, name: p.name, label: p.name, address: p.address, units: p.units,
              isAirbnb: p.isAirbnb,
              ...(p.market ? { market: p.market } : {}),
              ...(p.lat ? { lat: p.lat, lng: p.lng } : {}),
              ...(p.unitLabels?.length ? { unitLabels: p.unitLabels } : { unitLabels: undefined }),
            };
            await setUserProfile({ properties: currentProps });
            setProperties(currentProps);
            try {
              await apiFetch('/api/props', { method: 'POST', body: JSON.stringify({ props: currentProps }) });
            } catch {}

            // Collect iCal URLs from form (new or pre-filled)
            const allIcals: { url: string; unitLabel?: string }[] = [];
            if (p.icalUrl) {
              allIcals.push({ url: p.icalUrl });
            } else if (p.icalUrls) {
              p.icalUrls.forEach((u, i) => {
                if (u) allIcals.push({ url: u, unitLabel: p.unitLabels?.[i] || `Unit ${i + 1}` });
              });
            }

            // Get existing feeds for this property (to update names even if URLs unchanged)
            const existingPropFeeds = icalFeeds.filter((f: any) => f.propId === propId);
            const otherFeeds = icalFeeds.filter((f: any) => f.propId !== propId);

            let updatedFeeds = icalFeeds;
            if (allIcals.length) {
              // User provided URLs — rebuild feeds with new names
              const newFeeds = allIcals.map(ic => ({
                propId,
                listingName: ic.unitLabel ? `${p.name} - ${ic.unitLabel}` : p.name,
                url: ic.url,
              }));
              updatedFeeds = [...otherFeeds, ...newFeeds];
            } else if (existingPropFeeds.length > 0) {
              // No URLs in form but feeds exist — update listingNames for name/unit changes
              const renamedFeeds = existingPropFeeds.map((f: any, i: number) => ({
                ...f,
                listingName: p.unitLabels?.[i]
                  ? `${p.name} - ${p.unitLabels[i]}`
                  : p.units > 1
                    ? `${p.name} - Unit ${i + 1}`
                    : p.name,
              }));
              updatedFeeds = [...otherFeeds, ...renamedFeeds];
            }

            if (updatedFeeds !== icalFeeds) {
              try {
                await apiFetch('/api/ical/feeds', { method: 'POST', body: JSON.stringify({ feeds: updatedFeeds }) });
                setIcalFeeds(updatedFeeds);
                if (allIcals.length) {
                  try { await apiFetch('/api/ical/sync', { method: 'POST' }); } catch {}
                }
              } catch {}
            }
            // Always invalidate caches so renamed properties reflect everywhere
            invalidateAll();
            setEditingPropIndex(null);
          }}
        />
      </ScrollView>
    );
  }

  if (section === 'customTags') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Custom Tags</Text>
        <Text style={styles.pageDesc}>Create custom income or expense categories for tagging transactions.</Text>
        <CardGroup>
          {customCategories.length === 0 ? (
            <View style={styles.emptyRow}><Text style={styles.emptyText}>No custom tags yet</Text></View>
          ) : customCategories.map((cat: any, i: number) => (
            <React.Fragment key={cat.id}>
              <View style={styles.propRow}>
                <View style={styles.propInfo}>
                  <Text style={styles.propName}>{cat.label}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <View style={{
                      paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4,
                      backgroundColor: cat.type === 'income' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                    }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: cat.type === 'income' ? '#34D399' : '#F87171' }}>
                        {cat.type === 'income' ? 'INCOME' : 'EXPENSE'}
                      </Text>
                    </View>
                  </View>
                </View>
                <TouchableOpacity activeOpacity={0.7}
                  onPress={() => {
                    Alert.alert('Delete Tag', `Remove "${cat.label}"?`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: async () => {
                        await deleteCustomCategoryApi(cat.id);
                        setCustomCategories(prev => prev.filter((c: any) => c.id !== cat.id));
                      }},
                    ]);
                  }}>
                  <Text style={styles.deleteText}>Remove</Text>
                </TouchableOpacity>
              </View>
              {i < customCategories.length - 1 && <Divider />}
            </React.Fragment>
          ))}
        </CardGroup>
        <SectionTitle title="Add Custom Tag" />
        <CardGroup>
          <View style={{ padding: Spacing.md, gap: Spacing.sm }}>
            <TextInput
              style={styles.modalInput}
              value={customTagName}
              onChangeText={setCustomTagName}
              placeholder="Tag name (e.g. Landscaping)"
              placeholderTextColor={Colors.textDim}
              maxLength={40}
            />
            <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.propPill, customTagType === 'expense' && styles.propPillActive]}
                onPress={() => setCustomTagType('expense')}>
                <Text style={[styles.propPillText, customTagType === 'expense' && styles.propPillTextActive]}>Expense</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.propPill, customTagType === 'income' && styles.propPillActive]}
                onPress={() => setCustomTagType('income')}>
                <Text style={[styles.propPillText, customTagType === 'income' && styles.propPillTextActive]}>Income</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.modalSaveBtn, !customTagName.trim() && { opacity: 0.4 }]}
              disabled={!customTagName.trim()}
              onPress={async () => {
                await saveCustomCategoryApi(customTagName.trim(), customTagType);
                const cats = await fetchCustomCategoriesApi(true);
                setCustomCategories(cats);
                setCustomTagName('');
              }}>
              <Text style={styles.modalSaveText}>Save Tag</Text>
            </TouchableOpacity>
          </View>
        </CardGroup>
      </ScrollView>
    );
  }

  if (section === 'pricelabs') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>PriceLabs</Text>
        <Text style={styles.pageDesc}>Connect PriceLabs to get market occupancy data and nightly rate analytics for your properties.</Text>
        <SectionTitle title="API Configuration" />
        <CardGroup>
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>API Key</Text>
            <TextInput style={styles.settingsInput} value={priceLabsKey} onChangeText={setPriceLabsKey}
              placeholder="Enter your PriceLabs API key" placeholderTextColor={Colors.textDim}
              autoCapitalize="none" secureTextEntry />
          </View>
        </CardGroup>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.syncBtn} onPress={handleSavePriceLabs}>
          <Ionicons name="save" size={16} color="#fff" />
          <Text style={styles.syncBtnText}>Save API Key</Text>
        </TouchableOpacity>
        <SectionTitle title="How to get your API key" />
        <CardGroup>
          <View style={styles.helpRow}>
            <Text style={styles.helpStep}>1. Log in to your PriceLabs account</Text>
            <Text style={styles.helpStep}>2. Go to Account Settings → API Access</Text>
            <Text style={styles.helpStep}>3. Generate or copy your API key</Text>
            <Text style={styles.helpStep}>4. Paste it above and tap Save</Text>
          </View>
        </CardGroup>
      </ScrollView>
    );
  }

  if (section === 'income') {
    const incomeDesc = portfolioType === 'str'
      ? 'Record Airbnb direct deposits. Since Airbnb pays out as a lump sum, income is tracked as a total — not per-property.'
      : portfolioType === 'ltr'
      ? 'Add rental income per property — monthly rent, late fees, security deposits, or any other revenue.'
      : 'Add Airbnb lump-sum deposits or per-property income for non-Airbnb rentals.';
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Manual Income</Text>
        <Text style={styles.pageDesc}>{incomeDesc}</Text>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.addBtn} onPress={() => setShowAddIncome(true)}>
          <Ionicons name="add" size={18} color={Colors.primary} />
          <Text style={styles.addBtnText}>Add Manual Income</Text>
        </TouchableOpacity>
        <ManualIncomeModal visible={showAddIncome} onClose={() => setShowAddIncome(false)} properties={properties} portfolioType={portfolioType} onSave={handleAddManualIncome} />
      </ScrollView>
    );
  }

  if (section === 'plaid') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Plaid Connections</Text>
        <Text style={styles.pageDesc}>Connect your bank accounts to automatically import transactions. Portfolio Pigeon uses Plaid for secure bank connections.</Text>
        <SectionTitle title="Connected Accounts" />
        <CardGroup>
          {plaidAccounts.length === 0 ? (
            <View style={styles.emptyRow}><Text style={styles.emptyText}>No accounts connected — tap below to add one</Text></View>
          ) : plaidAccounts.map((a, i) => (
            <React.Fragment key={a.item_id || i}>
              <View style={styles.propRow}>
                <View style={styles.propInfo}>
                  <Text style={styles.propName}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</Text>
                  <Text style={styles.propType}>{a.institution || 'Bank account'}</Text>
                </View>
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => handleRemovePlaidAccount(a.item_id, a.name)}>
                  <Text style={styles.deleteText}>Remove</Text>
                </TouchableOpacity>
              </View>
              {i < plaidAccounts.length - 1 && <Divider />}
            </React.Fragment>
          ))}
        </CardGroup>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.addBtn, syncing && { opacity: 0.5 }]} onPress={handleConnectPlaid} disabled={syncing}>
          {syncing ? <ActivityIndicator size="small" color={Colors.primary} /> : <Ionicons name="add" size={18} color={Colors.primary} />}
          <Text style={styles.addBtnText}>{syncing ? 'Connecting...' : 'Connect Bank Account'}</Text>
        </TouchableOpacity>
        <SectionTitle title="Actions" />
        <CardGroup>
          <SettingRow icon="sync-outline" label="Sync Transactions"
            sub={syncing ? 'Syncing...' : 'Pull latest from connected accounts'}
            onPress={handleSync}
            right={syncing ? <ActivityIndicator size="small" color={Colors.primary} /> : undefined} />
          <Divider />
          <SettingRow icon="download-outline" label="Pull Full History" sub="Backfills up to 2 years of transactions"
            onPress={async () => {
              if (plaidAccounts.length === 0) {
                Alert.alert('No Accounts', 'Connect a bank account first to pull history.');
                return;
              }
              setSyncing(true);
              try {
                await apiFetch('/api/plaid/history', { method: 'POST' });
                await activateData();
                invalidateAll();
                Alert.alert('Done', 'Full transaction history pulled.');
              } catch (e: any) {
                Alert.alert('Error', e?.serverError || e?.message || 'Could not pull transaction history. Please try again.');
              }
              finally { setSyncing(false); }
            }} />
        </CardGroup>
        <PlaidLinkModal
          visible={showPlaidLink}
          linkToken={plaidLinkToken}
          onSuccess={handlePlaidSuccess}
          onExit={handlePlaidExit}
        />
      </ScrollView>
    );
  }

  if (section === 'cleanerFeeds') {
    const handleShareCode = async () => {
      try {
        const res = await apiGetFollowCode();
        await Share.share({ message: `Follow me on Portfolio Pigeon! Use code: ${res.follow_code}` });
      } catch { Alert.alert('Error', 'Could not get your follow code.'); }
    };

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Cleaner Feeds</Text>
        <Text style={styles.pageDesc}>Add your cleaning team and optionally link their calendar feeds to auto-schedule cleanings based on check-outs.</Text>
        <CardGroup>
          {cleanerFeeds.length === 0 ? (
            <View style={styles.emptyRow}><Text style={styles.emptyText}>No cleaners added yet</Text></View>
          ) : cleanerFeeds.map((feed, i) => (
            <React.Fragment key={i}>
              <View style={styles.propRow}>
                <View style={styles.propInfo}>
                  <Text style={styles.propName}>{feed.username ? `@${feed.username}` : feed.name || feed.cleanerName || `Cleaner ${i + 1}`}</Text>
                  <Text style={styles.propType}>{feed.propId || 'All properties'}</Text>
                  {feed.url ? <Text style={[styles.propType, { fontSize: 10 }]} numberOfLines={1}>{feed.url}</Text> : null}
                </View>
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => handleDeleteCleanerFeed(i)}>
                  <Text style={styles.deleteText}>Remove</Text>
                </TouchableOpacity>
              </View>
              {i < cleanerFeeds.length - 1 && <Divider />}
            </React.Fragment>
          ))}
        </CardGroup>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.addBtn} onPress={() => setShowAddCleaner(true)}>
          <Ionicons name="add" size={18} color={Colors.primary} />
          <Text style={styles.addBtnText}>Add Cleaner</Text>
        </TouchableOpacity>
        {userProfile?.accountType !== 'cleaner' && (
          <TouchableOpacity activeOpacity={0.7}
            style={[styles.addBtn, { marginTop: 8 }]} onPress={handleShareCode}>
            <Ionicons name="share-outline" size={18} color={Colors.primary} />
            <Text style={styles.addBtnText}>Share Your Code</Text>
          </TouchableOpacity>
        )}
        <AddCleanerFeedModal visible={showAddCleaner} onClose={() => setShowAddCleaner(false)} properties={properties} onSave={handleSaveCleanerFeed} />
      </ScrollView>
    );
  }

  if (section === 'notifications') {
    const notifItems = userProfile?.accountType === 'cleaner' ? [
      { key: 'newBooking', label: 'New Booking Alerts', sub: 'When a new reservation is made at a property you clean', icon: 'calendar-outline' },
      { key: 'cleaningNeeded', label: 'Cleaning Needed', sub: 'When a checkout creates a cleaning task', icon: 'sparkles-outline' },
      { key: 'invoiceReminder', label: 'Invoice Reminders', sub: 'Reminders for unsent/unpaid invoices', icon: 'document-text-outline' },
      { key: 'financial', label: 'Financial Updates', sub: 'Monthly revenue summary', icon: 'cash-outline' },
      { key: 'messages', label: 'Messages', sub: 'New messages and group chats', icon: 'chatbubble-outline' },
    ] : [
      { key: 'cleaning', label: 'Cleaning Alerts', sub: 'New checkout → cleaning needed', icon: 'sparkles-outline' },
      { key: 'checkin', label: 'Check-in Reminders', sub: 'Upcoming check-ins tomorrow', icon: 'calendar-outline' },
      { key: 'inventory', label: 'Inventory Alerts', sub: 'Items below threshold', icon: 'cube-outline' },
      { key: 'financial', label: 'Financial Updates', sub: 'Monthly P/L summary', icon: 'cash-outline' },
      { key: 'milestones', label: 'Revenue Milestones', sub: 'When you hit new records', icon: 'trophy-outline' },
      { key: 'messages', label: 'Messages', sub: 'New messages and group chats', icon: 'chatbubble-outline' },
    ];
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Notifications</Text>
        <Text style={styles.pageDesc}>Choose which push notifications you'd like to receive.</Text>
        <CardGroup>
          {notifItems.map((item, i, arr) => (
            <React.Fragment key={item.key}>
              <View style={styles.row}>
                <View style={styles.rowIconWrap}><Ionicons name={item.icon as any} size={18} color={Colors.primary} /></View>
                <View style={styles.rowText}>
                  <Text style={styles.rowLabel}>{item.label}</Text>
                  <Text style={styles.rowSub}>{item.sub}</Text>
                </View>
                <Switch
                  value={notifPrefs[item.key] !== false}
                  onValueChange={v => updateNotifPrefs({ [item.key]: v })}
                  trackColor={{ true: Colors.green, false: 'rgba(255,255,255,0.15)' }}
                />
              </View>
              {i < arr.length - 1 && <Divider />}
            </React.Fragment>
          ))}
        </CardGroup>
      </ScrollView>
    );
  }

  if (section === 'tagRules') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Tag Rules</Text>
        <Text style={styles.pageDesc}>Auto-tag rules categorize transactions by matching payee names. Create rules to automatically sort expenses.</Text>
        <CardGroup>
          {Object.keys(tagRules).length === 0 ? (
            <View style={styles.emptyRow}><Text style={styles.emptyText}>No rules yet — add one below</Text></View>
          ) : Object.entries(tagRules).map(([payee, propId], i, arr) => {
            const propIdx = properties.findIndex(p => p.id === propId);
            const propLabel = propIdx >= 0 ? (properties[propIdx].label || propId) : propId;
            return (
              <React.Fragment key={payee}>
                <View style={styles.tagRuleRow}>
                  <View style={styles.tagRuleInfo}>
                    <Text style={styles.tagRulePayee}>{payee.charAt(0) + payee.slice(1).toLowerCase()}</Text>
                    <View style={{ marginTop: 4 }}>
                      <TagPill tagId={propId} label={propLabel} propertyIndex={Math.max(propIdx, 0)} size="sm" />
                    </View>
                  </View>
                  <TouchableOpacity activeOpacity={0.7}
          onPress={() => handleDeleteTagRule(payee)}>
                    <Ionicons name="close-circle" size={22} color={Colors.textDim} />
                  </TouchableOpacity>
                </View>
                {i < arr.length - 1 && <Divider />}
              </React.Fragment>
            );
          })}
        </CardGroup>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.addBtn} onPress={() => setShowAddTagRule(true)}>
          <Ionicons name="add" size={18} color={Colors.primary} />
          <Text style={styles.addBtnText}>Add Tag Rule</Text>
        </TouchableOpacity>

        {/* Custom Tag Creation */}
        <SectionTitle title="Custom Tags" />
        <Text style={styles.pageDesc}>
          {userProfile?.accountType === 'cleaner'
            ? 'Create custom expense tags for your cleaning business (e.g., Gas, Cleaning Supplies, Equipment).'
            : 'Create custom tags to categorize transactions beyond property tags.'}
        </Text>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.addBtn} onPress={() => {
            Alert.prompt('New Custom Tag', 'Enter a tag name (e.g., Gas, Supplies, Insurance)', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Create', onPress: async (tagName?: string) => {
                if (!tagName?.trim()) return;
                try {
                  await apiFetch('/api/tags', { method: 'POST', body: JSON.stringify({ tag_name: tagName.trim() }) });
                  Alert.alert('Created', `Tag "${tagName.trim()}" created.`);
                } catch { Alert.alert('Error', 'Could not create tag.'); }
              }},
            ], 'plain-text');
          }}>
          <Ionicons name="pricetag-outline" size={18} color={Colors.primary} />
          <Text style={styles.addBtnText}>Add Custom Tag</Text>
        </TouchableOpacity>
        <AddTagRuleModal visible={showAddTagRule} onClose={() => setShowAddTagRule(false)} properties={properties} onSave={handleAddTagRule} />
      </ScrollView>
    );
  }

  // ═══════════════════════════════
  // ── BILLING SECTION ──
  // ═══════════════════════════════
  if (section === 'billing') {
    const subStatus = userProfile?.subscriptionStatus;
    const statusLabel = isFounder ? 'Founder (Lifetime Free)'
      : lifetimeFree ? 'Early Adopter (Lifetime Free)'
      : subStatus === 'active' ? 'Active'
      : subStatus === 'trialing' ? 'Free Trial'
      : subStatus === 'past_due' ? 'Past Due'
      : subStatus === 'canceled' ? 'Canceled'
      : 'No Subscription';
    const statusColor = (isFounder || lifetimeFree || subStatus === 'active' || subStatus === 'trialing')
      ? Colors.green : Colors.red;

    const handleSubscribe = async () => {
      try {
        if (Platform.OS === 'ios') {
          const result = await showProPaywall();
          if (result === 'purchased' || result === 'restored') {
            await fetchBillingStatus();
          }
        } else {
          const plan = userProfile?.accountType === 'cleaner' ? 'cleaner_pro_monthly' : 'pp_pro_monthly';
          const res = await apiFetch('/api/billing/create-checkout', {
            method: 'POST', body: JSON.stringify({ plan }),
          });
          if (res.checkout_url) {
            setCheckoutSessionId(res.session_id || '');
            setCheckoutUrl(res.checkout_url);
            setShowCheckout(true);
          }
        }
      } catch {
        if (Platform.OS !== 'ios') Alert.alert('Error', 'Could not start checkout.');
      }
    };

    const handleManage = async () => {
      setSyncing(true);
      try {
        if (Platform.OS === 'ios') {
          await Linking.openURL('https://apps.apple.com/account/subscriptions');
          await fetchBillingStatus();
        } else {
          const res = await apiFetch('/api/billing/create-portal', { method: 'POST' });
          if (res.portal_url) {
            setPortalUrl(res.portal_url);
            setShowPortal(true);
          }
        }
      } catch {
        Alert.alert('Error', Platform.OS === 'ios' ? 'Could not open subscription management.' : 'Could not open billing portal.');
      } finally { setSyncing(false); }
    };

    const handleRestore = async () => {
      setSyncing(true);
      try {
        const Purchases = require('react-native-purchases').default;
        await Purchases.restorePurchases();
        await fetchBillingStatus();
        Alert.alert('Restored', 'Purchases have been restored.');
      } catch {
        Alert.alert('Error', 'Could not restore purchases.');
      } finally { setSyncing(false); }
    };

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
        <BackButton onPress={() => setSection('main')} />
        <Text style={styles.pageTitle}>Subscription</Text>
        <Text style={styles.pageDesc}>Manage your Portfolio Pigeon subscription.</Text>

        <CardGroup>
          <View style={styles.row}>
            <View style={styles.rowIconWrap}>
              <Ionicons name="diamond-outline" size={18} color={statusColor} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Status</Text>
              <Text style={[styles.rowSub, { color: statusColor, fontWeight: '600' }]}>{statusLabel}</Text>
            </View>
          </View>
        </CardGroup>

        {!(isFounder || lifetimeFree) && (
          <>
            {billingActive ? (
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.syncBtn, syncing && { opacity: 0.5 }]} onPress={handleManage} disabled={syncing}>
                <Ionicons name="settings-outline" size={16} color="#fff" />
                <Text style={styles.syncBtnText}>{syncing ? 'Loading...' : 'Manage Subscription'}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.syncBtn, syncing && { opacity: 0.5 }]} onPress={handleSubscribe} disabled={syncing}>
                <Ionicons name="diamond-outline" size={16} color="#fff" />
                <Text style={styles.syncBtnText}>{syncing ? 'Loading...' : 'Subscribe — Free Trial'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.addBtn, { marginTop: Spacing.sm }]} onPress={handleRestore} disabled={syncing}>
              <Ionicons name="refresh" size={16} color={Colors.primary} />
              <Text style={styles.addBtnText}>Restore Purchases</Text>
            </TouchableOpacity>
          </>
        )}

      </ScrollView>
    );
  }

  // ═══════════════════════════════
  // ── TRANSACTIONS SECTION ──
  // ═══════════════════════════════
  if (section === 'transactions') {
    const q = txSearch.toLowerCase();
    const filtered = q
      ? allTransactions.filter((t: any) => {
          const fields = [t.name, t.merchant, t.description, t.category, t.property_tag].filter(Boolean);
          return fields.some((f: string) => f.toLowerCase().includes(q));
        })
      : allTransactions;

    const propLabel = (pid: string) => {
      const p = properties.find((p: any) => (p.id || p.prop_id) === pid);
      return p?.label || pid;
    };

    const renderTxItem = ({ item: t }: { item: any }) => {
      const isEditing = txEditingId === t.id;
      const amt = t.amount ?? 0;
      return (
        <View>
          <TouchableOpacity activeOpacity={0.7} onPress={() => startTxEdit(t)} style={styles.propRow}>
            <View style={styles.propInfo}>
              <Text style={styles.propName} numberOfLines={1}>
                {t.name || t.merchant || t.description || 'Transaction'}
              </Text>
              <Text style={styles.propType}>
                {fmtDate(t.date || '')}{t.property_tag ? ` · ${propLabel(t.property_tag)}` : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: amt >= 0 ? Colors.green : Colors.red }}>
                {fmt$(Math.abs(amt))}
              </Text>
              <Ionicons
                name={isEditing ? 'chevron-up' : 'create-outline'}
                size={14}
                color={isEditing ? Colors.primary : Colors.textDim}
              />
            </View>
          </TouchableOpacity>

          {isEditing && (
            <View style={styles.txEditCard}>
              <View style={{ marginBottom: Spacing.sm }}>
                <Text style={styles.inputLabel}>Amount</Text>
                <TextInput style={styles.settingsInput} value={txEditFields.amount}
                  onChangeText={v => setTxEditFields(f => ({ ...f, amount: v }))}
                  keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.textDim}
                  maxLength={12} />
              </View>
              <View style={{ marginBottom: Spacing.sm }}>
                <Text style={styles.inputLabel}>Name</Text>
                <TextInput style={styles.settingsInput} value={txEditFields.name}
                  onChangeText={v => setTxEditFields(f => ({ ...f, name: v }))}
                  placeholder="Transaction name" placeholderTextColor={Colors.textDim}
                  maxLength={200} />
              </View>
              <View style={{ marginBottom: Spacing.sm }}>
                <Text style={styles.inputLabel}>Date</Text>
                <TextInput style={styles.settingsInput} value={txEditFields.date}
                  onChangeText={v => setTxEditFields(f => ({ ...f, date: v }))}
                  placeholder="YYYY-MM-DD" placeholderTextColor={Colors.textDim}
                  maxLength={10} />
              </View>
              <View style={{ marginBottom: Spacing.sm }}>
                <Text style={styles.inputLabel}>Category</Text>
                <TextInput style={styles.settingsInput} value={txEditFields.category}
                  onChangeText={v => setTxEditFields(f => ({ ...f, category: v }))}
                  placeholder="e.g. utilities, rent" placeholderTextColor={Colors.textDim}
                  maxLength={100} />
              </View>
              {properties.length > 0 && (
                <View style={{ marginBottom: Spacing.sm }}>
                  <Text style={styles.inputLabel}>Property</Text>
                  <View style={styles.propPillRow}>
                    <TouchableOpacity activeOpacity={0.7}
                      style={[styles.propPill, !txEditFields.property_tag && styles.propPillActive]}
                      onPress={() => setTxEditFields(f => ({ ...f, property_tag: '' }))}>
                      <Text style={[styles.propPillText, !txEditFields.property_tag && styles.propPillTextActive]}>None</Text>
                    </TouchableOpacity>
                    {properties.map(p => (
                      <TouchableOpacity key={p.id} activeOpacity={0.7}
                        style={[styles.propPill, txEditFields.property_tag === p.id && styles.propPillActive]}
                        onPress={() => setTxEditFields(f => ({ ...f, property_tag: p.id }))}>
                        <Text style={[styles.propPillText, txEditFields.property_tag === p.id && styles.propPillTextActive]}>
                          {p.label || p.id}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
              <View style={styles.modalBtns}>
                <TouchableOpacity activeOpacity={0.7} style={styles.modalCancelBtn}
                  onPress={() => { setTxEditingId(null); setTxEditFields({}); }}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
                  style={[styles.modalSaveBtn, txSaving && { opacity: 0.5 }]}
                  onPress={handleTxSave} disabled={txSaving}>
                  {txSaving ? <ActivityIndicator size="small" color="#fff" /> : (
                    <>
                      <Ionicons name="checkmark" size={16} color="#fff" />
                      <Text style={styles.modalSaveText}>Save</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          <Divider />
        </View>
      );
    };

    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <BackButton onPress={() => { setSection('main'); setTxSearch(''); setTxEditingId(null); }} />
          <Text style={styles.pageTitle}>Transactions</Text>

          {/* Search bar */}
          <View style={[styles.settingsInput, { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: Spacing.md }]}>
            <Ionicons name="search" size={16} color={Colors.textDim} />
            <TextInput
              style={{ flex: 1, color: Colors.text, fontSize: FontSize.md, padding: 0 }}
              value={txSearch}
              onChangeText={setTxSearch}
              placeholder="Search transactions..."
              placeholderTextColor={Colors.textDim}
              autoCorrect={false}
            />
            {txSearch ? (
              <TouchableOpacity activeOpacity={0.7} onPress={() => setTxSearch('')}>
                <Ionicons name="close-circle" size={18} color={Colors.textDim} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Count header */}
          <Text style={styles.sectionTitle}>
            {txLoading ? 'LOADING...' : `${filtered.length} TRANSACTION${filtered.length !== 1 ? 'S' : ''}`}
          </Text>
        </View>

        {txLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={Colors.green} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg }}>
            <Ionicons name="receipt-outline" size={40} color={Colors.textDim} />
            <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md }}>
              {txSearch ? 'No matching transactions' : 'No transactions yet'}
            </Text>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center', marginTop: Spacing.xs }}>
              {txSearch ? 'Try a different search term' : 'Connect Plaid or add manual income in Settings to see transactions here.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(t, i) => t.id || String(i)}
            renderItem={renderTxItem}
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            windowSize={5}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: Spacing.md, paddingBottom: Spacing.xl * 2 }}
          />
        )}
      </View>
    );
  }

  // ═══════════════════════════════
  // ── INVOICES RECEIVED ──
  // ═══════════════════════════════
  if (section === 'invoices') {
    return <InvoicesReceivedSection onBack={() => setSection('main')} />;
  }

  // ═══════════════════════════════
  // ── MAIN SETTINGS ──
  // ═══════════════════════════════
  return (
    <View style={{ flex: 1 }}>
    <GradientHeader />
    <ScrollView style={[styles.container, { backgroundColor: 'transparent' }]} contentContainerStyle={styles.content} {...({delaysContentTouches: false} as any)}>
      {loading && <ActivityIndicator size="small" color={Colors.primary} style={{ marginBottom: Spacing.md }} />}

      {userProfile?.accountType === 'cleaner' ? (
        <>
          <SectionTitle title="Data Sources" />
          <CardGroup>
            <SettingRow icon="card-outline" label="Plaid Connections" sub={isReadOnly ? "Subscribe to Pro" : `${plaidAccounts.length} accounts connected`} onPress={isReadOnly ? handleProGate : () => setSection('plaid')} />
          </CardGroup>

          <SectionTitle title="Data" />
          <CardGroup>
            <SettingRow icon="refresh-outline" label="Refresh All Data" sub="Clear cache and reload" onPress={handleRefreshAll} />
          </CardGroup>
        </>
      ) : (
        <>
          <SectionTitle title="Properties" />
          <CardGroup>
            <SettingRow icon="home-outline" label="Manage Properties" sub={`${properties.length} properties`} onPress={() => setSection('properties')} />
          </CardGroup>

          <SectionTitle title="Data Sources" />
          <CardGroup>
            {!isLTR && (
              <>
                <SettingRow icon="analytics-outline" label="PriceLabs" sub="Market data & pricing" onPress={() => setSection('pricelabs')} />
                <Divider />
              </>
            )}
            <SettingRow icon="card-outline" label="Plaid Connections" sub={isReadOnly ? "Subscribe to Pro" : `${plaidAccounts.length} accounts connected`} onPress={isReadOnly ? handleProGate : () => setSection('plaid')} />
            {/* Cleaner Feeds removed — iCal feeds managed within Manage Properties */}
          </CardGroup>

          <SectionTitle title="Income" />
          <CardGroup>
            <SettingRow icon="wallet-outline" label="Manual Income" sub="Add income not captured automatically" onPress={() => setSection('income')} />
            <Divider />
            <SettingRow icon="pricetag-outline" label="Tag Rules" sub={`${Object.keys(tagRules).length} auto-tag rules`} onPress={() => setSection('tagRules')} />
            <Divider />
            <SettingRow icon="pricetags-outline" label="Custom Tags" sub={`${customCategories.length} custom tags`} onPress={() => setSection('customTags')} />
          </CardGroup>

          <SectionTitle title="Data" />
          <CardGroup>
            <SettingRow icon="sync-outline" label="Sync Transactions" sub={syncing ? 'Syncing...' : 'Pull latest from connected accounts'}
              onPress={handleSync} right={syncing ? <ActivityIndicator size="small" color={Colors.primary} /> : undefined} />
            <Divider />
            <SettingRow icon="refresh-outline" label="Refresh All Data" sub="Clear cache and reload" onPress={handleRefreshAll} />
            <Divider />
            <SettingRow icon="receipt-outline" label="All Transactions" sub="Browse and edit imported transactions"
              onPress={() => { setSection('transactions'); loadTransactions(); }} />
          </CardGroup>

          <SectionTitle title="Invoices" />
          <CardGroup>
            <SettingRow icon="document-text-outline" label="Invoices Received" sub={isReadOnly ? "Subscribe to Pro" : "View invoices from your cleaners"} onPress={isReadOnly ? handleProGate : () => setSection('invoices')} />
          </CardGroup>
        </>
      )}

      <SectionTitle title="Your HQ" />
      <CardGroup>
        <UsernameEditor currentUsername={userProfile?.username || ''} />
        <Divider />
        <SettingRow icon="mail-outline" label="Email" sub={userProfile?.email || ''} chevron={false} />
        {isSTR && userProfile?.accountType !== 'cleaner' && (
          <>
            <Divider />
            {isReadOnly ? (
              <SettingRow
                icon="people-outline"
                label="Cleaner Code"
                sub="Subscribe to Pro to reveal cleaner code"
                onPress={handleProGate}
              />
            ) : followCodeValue ? (
              <SettingRow
                icon="people-outline"
                label="Cleaner Code"
                sub={followCodeValue}
                chevron={false}
                right={
                  <TouchableOpacity activeOpacity={0.7} onPress={() => Clipboard.setStringAsync(followCodeValue)}>
                    <Ionicons name="copy-outline" size={18} color={Colors.primary} />
                  </TouchableOpacity>
                }
              />
            ) : null}
          </>
        )}
      </CardGroup>

      <SectionTitle title="Notifications" />
      <CardGroup>
        <SettingRow icon="notifications-outline" label="Notifications" sub="Manage push notification preferences" onPress={() => setSection('notifications')} />
      </CardGroup>

      {/* Tab Order */}
      {(() => {
        const isCleaner = userProfile?.accountType === 'cleaner';
        let order: string[];

        if (isCleaner) {
          // Cleaner pill order — Profile always first
          const CLEANER_ORDER = ['profile', 'schedule', 'money', 'owners', 'invoices'];
          order = userProfile?.pillOrder || CLEANER_ORDER;
          // Ensure all cleaner pills present
          for (const pill of CLEANER_ORDER) {
            if (!order.includes(pill)) order.push(pill);
          }
          // Remove pills that don't belong
          order = order.filter(k => CLEANER_ORDER.includes(k));
          // Pin Profile first
          order = ['profile', ...order.filter(k => k !== 'profile')];
        } else {
          // Owner pill order
          const BASE_ORDER = ['profile', 'home', 'performance', 'projections'];
          const STR_PILLS = ['calendar', 'inventory'];
          const isSTRUser = userProfile?.portfolioType === 'str' || userProfile?.portfolioType === 'both';
          const DEFAULT_ORDER = isSTRUser ? [...BASE_ORDER, ...STR_PILLS] : BASE_ORDER;
          const raw = userProfile?.pillOrder || DEFAULT_ORDER;
          // Migrate old keys
          const hasLegacy = raw.some((k: string) => k === 'monthly' || k === 'quarterly' || k === 'annual');
          if (hasLegacy) {
            const migrated: string[] = [];
            let addedPerf = false;
            for (const key of raw) {
              if (key === 'monthly' || key === 'quarterly' || key === 'annual') {
                if (!addedPerf) { migrated.push('performance'); addedPerf = true; }
              } else { migrated.push(key); }
            }
            order = migrated;
          } else {
            order = [...raw];
          }
          // Remove deprecated pills from saved order
          order = order.filter(k => k !== 'feed' && k !== 'occupancy');
          // Ensure base pills
          if (!order.includes('performance')) order.push('performance');
          if (!order.includes('projections')) {
            const perfIdx = order.indexOf('performance');
            order.splice(perfIdx + 1, 0, 'projections');
          }
          // Handle STR pills
          if (isSTRUser) {
            for (const pill of STR_PILLS) {
              if (!order.includes(pill)) order.push(pill);
            }
          } else {
            order = order.filter(k => !STR_PILLS.includes(k));
          }
          // Pin Profile first
          order = ['profile', ...order.filter(k => k !== 'profile')];
        }
        const move = (from: number, to: number) => {
          if (from === 0 || to === 0) return; // Profile is pinned
          const next = [...order];
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item);
          setUserProfile({ pillOrder: next });
        };
        return (
          <>
            <SectionTitle title="Tab Order" />
            <CardGroup>
              {order.map((key, i) => {
                const isPinned = key === 'profile';
                return (
                  <React.Fragment key={key}>
                    <View style={styles.row}>
                      <View style={styles.rowIconWrap}>
                        <Ionicons name={isPinned ? 'lock-closed-outline' : 'menu-outline'} size={18} color={isPinned ? Colors.textDim : Colors.primary} />
                      </View>
                      <View style={styles.rowText}>
                        <Text style={styles.rowLabel}>{PILL_LABELS[key] || key}</Text>
                      </View>
                      {isPinned ? (
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textDim }}>Pinned</Text>
                      ) : (
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                          <TouchableOpacity activeOpacity={0.7}
                            disabled={i <= 1}
                            onPress={() => move(i, i - 1)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ opacity: i <= 1 ? 0.2 : 1 }}
                          >
                            <Ionicons name="chevron-up" size={22} color={Colors.textDim} />
                          </TouchableOpacity>
                          <TouchableOpacity activeOpacity={0.7}
                            disabled={i === order.length - 1}
                            onPress={() => move(i, i + 1)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ opacity: i === order.length - 1 ? 0.2 : 1 }}
                          >
                            <Ionicons name="chevron-down" size={22} color={Colors.textDim} />
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                    {i < order.length - 1 && <Divider />}
                  </React.Fragment>
                );
              })}
            </CardGroup>
          </>
        );
      })()}

      <SectionTitle title="Billing" />
      <CardGroup>
        <SettingRow icon="diamond-outline" label="Subscription"
          sub={isFounder ? 'Founder — Lifetime Free'
            : lifetimeFree ? 'Early Adopter — Lifetime Free'
            : billingActive ? (userProfile?.subscriptionStatus === 'trialing' ? 'Free Trial Active' : 'Active')
            : 'Not Subscribed'}
          onPress={() => setSection('billing')} />
      </CardGroup>

      <SectionTitle title="Referrals" />
      <CardGroup>
        <SettingRow icon="share-outline" label="Share" sub="Invite friends & earn $20 per referral"
          onPress={() => {
            Share.share({
              message: `Join me on Portfolio Pigeon! Sign up here: https://portfoliopigeon.com`,
            });
          }}
        />
      </CardGroup>

      <SectionTitle title="Privacy" />
      <CardGroup>
        <View style={styles.row}>
          <View style={styles.rowIconWrap}><Ionicons name="lock-closed-outline" size={18} color={Colors.primary} /></View>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Private Account</Text>
            <Text style={styles.rowSub}>Others must request to follow you</Text>
          </View>
          <Switch
            value={isPrivate}
            onValueChange={async (v) => {
              setIsPrivate(v);
              try {
                await apiFetch('/api/profile/privacy', {
                  method: 'POST',
                  body: JSON.stringify({ is_private: v }),
                });
              } catch {
                setIsPrivate(!v);
              }
            }}
            trackColor={{ true: Colors.green, false: 'rgba(255,255,255,0.15)' }}
          />
        </View>
      </CardGroup>

      <SectionTitle title="Legal" />
      <CardGroup>
        <SettingRow icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => Linking.openURL('https://portfoliopigeon.com/privacy')} />
        <Divider />
        <SettingRow icon="document-text-outline" label="Terms of Service" onPress={() => Linking.openURL('https://portfoliopigeon.com/terms')} />
      </CardGroup>

      <SectionTitle title="Account" />
      <CardGroup>
        <SettingRow icon="log-out-outline" label="Sign Out" sub="Sign out of your account" onPress={handleSignOut} labelColor={Colors.red} />
      </CardGroup>

      <CardGroup>
        <SettingRow icon="trash-outline" label="Delete Account" sub="Permanently delete your account and all data" onPress={handleDeleteAccount} labelColor={Colors.red} />
      </CardGroup>

      <Text style={styles.version}>Portfolio Pigeon v1.0.0</Text>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl * 2 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.sm },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  pageTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  pageDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },
  sectionTitle: {
    fontSize: FontSize.xs, color: Colors.textDim, textTransform: 'uppercase',
    letterSpacing: 0.8, fontWeight: '600', paddingTop: Spacing.md, paddingBottom: Spacing.xs, paddingHorizontal: Spacing.xs,
  },
  cardGroup: {
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl, borderWidth: 0.5,
    borderColor: Colors.glassBorder, overflow: 'hidden', marginBottom: Spacing.sm,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 3 },
    }),
  },
  row: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, gap: Spacing.sm },
  rowIconWrap: { width: 30, height: 30, borderRadius: 7, backgroundColor: Colors.primaryDim, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1 },
  rowLabel: { fontSize: FontSize.md, color: Colors.text },
  rowSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 56 },
  propRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  propInfo: { flex: 1, marginRight: Spacing.sm },
  propName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  propType: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  deleteText: { fontSize: FontSize.sm, color: Colors.red, fontWeight: '500' },
  emptyRow: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center' },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: Spacing.md, borderRadius: Radius.md,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
    backgroundColor: Colors.primaryDim, marginBottom: Spacing.md,
  },
  addBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  syncBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: Spacing.md, borderRadius: Radius.md, backgroundColor: Colors.primary, marginBottom: Spacing.md,
  },
  syncBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: '#fff' },
  btnRow: { gap: Spacing.sm },
  inputRow: { padding: Spacing.md },
  inputLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs, marginTop: Spacing.sm },
  settingsInput: {
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  helpRow: { padding: Spacing.md },
  helpStep: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 24 },
  version: { textAlign: 'center', color: Colors.textDim, fontSize: FontSize.xs, marginTop: Spacing.xl },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.60)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: Colors.glassOverlay, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, padding: Spacing.lg, paddingBottom: Spacing.xl * 2 },
  modalHandle: { width: 36, height: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.lg },
  modalSectionLabel: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.8, color: Colors.textDim, textTransform: 'uppercase', marginBottom: Spacing.sm },
  modalHelpText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md, lineHeight: 20 },
  modalHelpTextSmall: { fontSize: FontSize.xs, color: Colors.textDim, marginBottom: Spacing.sm, lineHeight: 16 },
  modalFieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.xs },
  modalInput: { backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder, borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md, marginBottom: Spacing.sm },
  typeBadgeRow: { marginTop: Spacing.xs, marginBottom: Spacing.sm },
  typeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.pill, alignSelf: 'flex-start' },
  typeBadgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  modalBtns: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  modalCancelBtn: { flex: 1, padding: Spacing.md, borderRadius: Radius.md, backgroundColor: Colors.glassDark, alignItems: 'center', borderWidth: 0.5, borderColor: Colors.glassBorder },
  modalCancelText: { color: Colors.textSecondary, fontSize: FontSize.md },
  modalSaveBtn: { flex: 1, padding: Spacing.md, borderRadius: Radius.md, backgroundColor: Colors.primary, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  modalSaveText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  typeToggleRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  typeBtn: { flex: 1, padding: Spacing.sm, borderRadius: Radius.md, borderWidth: 0.5, borderColor: Colors.glassBorder, alignItems: 'center', backgroundColor: Colors.glassDark },
  typeBtnActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryDim },
  typeBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  typeBtnTextActive: { color: Colors.primary, fontWeight: '600' },
  tagPillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.md },
  tagRuleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  tagRuleInfo: { flex: 1, marginRight: Spacing.sm },
  tagRulePayee: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  propPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginBottom: Spacing.md },
  propPill: { paddingHorizontal: Spacing.sm, paddingVertical: 6, borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Colors.glassBorder, backgroundColor: Colors.glassDark },
  propPillActive: { backgroundColor: Colors.primaryDim, borderColor: Colors.primary },
  propPillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  propPillTextActive: { color: Colors.primary, fontWeight: '600' },
  incomeTypeLabel: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.primaryDim, borderRadius: Radius.md,
    padding: Spacing.sm, paddingHorizontal: Spacing.md, marginBottom: Spacing.md,
  },
  incomeTypeDot: { width: 8, height: 8, borderRadius: 4 },
  incomeTypeLabelText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },
  txEditCard: {
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg, padding: Spacing.md,
    marginHorizontal: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  selectedUserChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primaryDim, borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md, paddingVertical: 8, marginBottom: Spacing.sm,
    alignSelf: 'flex-start',
  },
  selectedUserText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },
  searchResultsList: {
    backgroundColor: Colors.glass, borderRadius: Radius.md,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.sm, overflow: 'hidden',
  },
  searchResultRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    borderBottomWidth: 0.5, borderBottomColor: Colors.glassBorder,
  },
  searchResultName: { fontSize: FontSize.md, color: Colors.text, fontWeight: '500', flex: 1 },
  roleBadge: {
    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  roleBadgeText: { fontSize: FontSize.xs, color: Colors.green, fontWeight: '600' },
});
