import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, ScrollView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PaywallResult } from '../../hooks/useProCheckout';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import { apiFetch } from '../../services/api';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { PlaidLinkModal } from '../../components/PlaidLink';


export function DataSourcesScreen({ navigation }: any) {
  const setProfile = useUserStore(s => s.setProfile);
  const portfolioType = useUserStore(s => s.profile?.portfolioType);

  const showSTRSources = portfolioType === 'str' || portfolioType === 'both';

  // PriceLabs
  const [plKey, setPlKey] = useState('');
  const [plConnected, setPlConnected] = useState(false);

  // iCal
  const [icalUrl, setIcalUrl] = useState('');
  const [icalPropName, setIcalPropName] = useState('');
  const [icalFeeds, setIcalFeeds] = useState<{ url: string; propertyName: string }[]>([]);

  // Plaid
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const [plaidLoading, setPlaidLoading] = useState(false);
  const [plaidLinkToken, setPlaidLinkToken] = useState('');
  const [showPlaidLink, setShowPlaidLink] = useState(false);
  const [plaidConnected, setPlaidConnected] = useState(false);

  const handleConnectPriceLabs = async () => {
    if (!plKey.trim()) { Alert.alert('Required', 'Enter your PriceLabs API key'); return; }
    // Store locally — will sync after registration
    await setProfile({ priceLabsApiKey: plKey.trim() });
    setPlConnected(true);
  };

  const isValidUrl = (u: string) => /^https?:\/\/.+\..+/.test(u);

  const handleAddIcalFeed = () => {
    if (!icalUrl.trim()) { Alert.alert('Required', 'Enter an iCal URL'); return; }
    if (!isValidUrl(icalUrl.trim())) { Alert.alert('Invalid', 'Enter a valid URL starting with http:// or https://'); return; }
    const feed = { url: icalUrl.trim(), propertyName: icalPropName.trim() || 'Feed' };
    setIcalFeeds(prev => [...prev, feed]);
    setIcalUrl(''); setIcalPropName('');
  };

  const handleRemoveIcalFeed = (index: number) => {
    setIcalFeeds(prev => prev.filter((_, i) => i !== index));
  };

  // ── Plaid Link Flow ──

  const handleStartPlaid = async () => {
    // Gate behind subscription
    if (isReadOnly) {
      const result = await checkout.startCheckout();
      if (result !== 'purchased' && result !== 'restored') {
        return; // User didn't subscribe
      }
    }

    // Fetch link token and open Plaid
    setPlaidLoading(true);
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
      setPlaidLoading(false);
    }
  };

  const handlePlaidSuccess = async (publicToken: string, accountName: string) => {
    setShowPlaidLink(false);
    try {
      await apiFetch('/api/exchange-token', {
        method: 'POST',
        body: JSON.stringify({ public_token: publicToken, account_name: accountName }),
      });
      await setProfile({ plaidConnected: true });
      setPlaidConnected(true);
    } catch {
      Alert.alert('Error', 'Could not link your bank account. You can try again from Settings.');
    }
  };

  const handleNext = async () => {
    if (icalFeeds.length > 0) {
      // Save feeds to backend API
      try {
        const feeds = icalFeeds.map(f => ({
          propId: f.propertyName,
          listingName: f.propertyName,
          url: f.url,
        }));
        await apiFetch('/api/ical/feeds', { method: 'POST', body: JSON.stringify({ feeds }) });
      } catch {}
    }
    navigation.navigate('Billing');
  };

  const handleSkip = () => {
    navigation.navigate('Billing');
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <View style={styles.progress}>
          {[1, 2, 3, 4, 5, 6].map(s => (
            <View key={s} style={[styles.dot, s <= 4 && styles.dotActive]} />
          ))}
        </View>

        <Text style={styles.title}>Connect your data</Text>
        <Text style={styles.subtitle}>
          Link your accounts to auto-import data. All sections are optional.
        </Text>

        {/* PriceLabs — STR/Both only */}
        {showSTRSources && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: Colors.primaryDim }]}>
                <Ionicons name="analytics-outline" size={18} color={Colors.primary} />
              </View>
              <Text style={styles.sectionTitle}>PriceLabs</Text>
              {plConnected && <Ionicons name="checkmark-circle" size={18} color={Colors.green} />}
            </View>
            <Text style={styles.sectionHint}>Compare occupancy and rates against market peers.</Text>
            {!plConnected ? (
              <View style={styles.sectionBody}>
                <TextInput
                  style={styles.input}
                  value={plKey}
                  onChangeText={setPlKey}
                  placeholder="Enter your PriceLabs API key"
                  placeholderTextColor={Colors.textDim}
                  autoCapitalize="none"
                  autoComplete="off"
                />
                <TouchableOpacity activeOpacity={0.7}
          style={styles.connectBtn} onPress={handleConnectPriceLabs}>
                  <Text style={styles.connectBtnText}>Connect</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.connectedText}>Connected</Text>
            )}
          </View>
        )}

        {/* iCal Feeds — STR/Both only */}
        {showSTRSources && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: Colors.greenDim }]}>
                <Ionicons name="calendar-outline" size={18} color={Colors.green} />
              </View>
              <Text style={styles.sectionTitle}>iCal Feeds</Text>
            </View>
            <Text style={styles.sectionHint}>No PriceLabs? Add iCal feeds for occupancy data and cleaning coordination.</Text>
            <View style={styles.sectionBody}>
              {icalFeeds.map((feed, i) => (
                <View key={i} style={styles.feedRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.feedName}>{feed.propertyName}</Text>
                    <Text style={styles.feedUrl} numberOfLines={1}>{feed.url}</Text>
                  </View>
                  <TouchableOpacity activeOpacity={0.7}
          onPress={() => handleRemoveIcalFeed(i)}>
                    <Ionicons name="close-circle" size={18} color={Colors.textDim} />
                  </TouchableOpacity>
                </View>
              ))}
              <TextInput
                style={styles.input}
                value={icalPropName}
                onChangeText={setIcalPropName}
                placeholder="Property name for this feed"
                placeholderTextColor={Colors.textDim}
                autoComplete="off"
              />
              <TextInput
                style={[styles.input, { marginTop: Spacing.sm }]}
                value={icalUrl}
                onChangeText={setIcalUrl}
                placeholder="https://www.airbnb.com/calendar/ical/..."
                placeholderTextColor={Colors.textDim}
                autoCapitalize="none"
                keyboardType="url"
                autoComplete="off"
              />
              <TouchableOpacity activeOpacity={0.7}
          style={styles.addFeedBtn} onPress={handleAddIcalFeed}>
                <Ionicons name="add" size={16} color={Colors.green} />
                <Text style={styles.addFeedText}>Add Feed</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Plaid */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={[styles.sectionIcon, { backgroundColor: Colors.yellowDim }]}>
              <Ionicons name="card-outline" size={18} color={Colors.yellow} />
            </View>
            <Text style={styles.sectionTitle}>Plaid Banking</Text>
            {plaidConnected && <Ionicons name="checkmark-circle" size={18} color={Colors.green} />}
          </View>
          <Text style={styles.sectionHint}>Track income and expenses across your properties and business.</Text>
          <View style={styles.sectionBody}>
            {!plaidConnected ? (
              <TouchableOpacity activeOpacity={0.7}
                style={styles.plaidBtn}
                onPress={handleStartPlaid}
                disabled={plaidLoading}
              >
                {plaidLoading ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Ionicons name="link-outline" size={18} color={Colors.primary} />
                )}
                <Text style={styles.plaidBtnText}>
                  {plaidLoading ? 'Connecting...' : 'Connect Bank Account'}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.connectedText}>Connected</Text>
            )}
          </View>
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleNext} activeOpacity={0.8}>
            <Text style={styles.primaryBtnText}>Next</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.8}>
            <Text style={styles.skipText}>Skip All</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <PlaidLinkModal
        visible={showPlaidLink}
        linkToken={plaidLinkToken}
        onSuccess={handlePlaidSuccess}
        onExit={() => setShowPlaidLink(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.primary, width: 24 },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },

  section: {
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg, marginBottom: Spacing.md, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 10 },
    }),
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  sectionIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  sectionBody: { padding: Spacing.md, paddingTop: Spacing.sm },
  sectionHint: { fontSize: FontSize.xs, color: Colors.textDim, lineHeight: 16, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  connectedText: { padding: Spacing.md, fontSize: FontSize.sm, color: Colors.green, fontWeight: '500' },

  input: {
    backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  connectBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    padding: Spacing.sm + 2, alignItems: 'center', marginTop: Spacing.sm,
  },
  connectBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },

  feedRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.greenDim, borderRadius: Radius.md,
    padding: Spacing.sm, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm,
  },
  feedName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  feedUrl: { fontSize: 10, color: Colors.textDim, marginTop: 1 },
  addFeedBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    padding: Spacing.sm, borderRadius: Radius.md, marginTop: Spacing.sm,
    borderWidth: 1, borderColor: Colors.green + '40', borderStyle: 'dashed',
    backgroundColor: Colors.greenDim,
  },
  addFeedText: { fontSize: FontSize.sm, color: Colors.green, fontWeight: '500' },

  plaidBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderRadius: Radius.md,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
    backgroundColor: Colors.primaryDim,
  },
  plaidBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },

  buttons: { gap: Spacing.sm, marginTop: Spacing.md, marginBottom: Spacing.xl },
  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: Colors.textDim, fontSize: FontSize.sm },
});
