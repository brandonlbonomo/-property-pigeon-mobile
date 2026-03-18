import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  KeyboardAvoidingView, ScrollView, Platform, ActivityIndicator, Image,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUserStore, UserProperty, generatePropertyId } from '../../store/userStore';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { AddressAutocomplete, ResolvedAddress } from '../../components/AddressAutocomplete';
import { PropertyStreetView } from '../../components/PropertyStreetView';
import { MAPS_PROXY_URL } from '../../constants/api';
import { apiFetch } from '../../services/api';


const FREE_PROPERTY_LIMIT = 2;

export function AddPropertiesScreen({ navigation }: any) {
  const portfolioType = useOnboardingStore(s => s.portfolioType);
  const setProfile = useUserStore(s => s.setProfile);
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();

  const [properties, setProperties] = useState<UserProperty[]>([]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [units, setUnits] = useState('1');
  const [isAirbnb, setIsAirbnb] = useState(portfolioType === 'str');
  const [market, setMarket] = useState('');
  const [resolvedAddress, setResolvedAddress] = useState<ResolvedAddress | null>(null);
  const [unitsPerYear, setUnitsPerYear] = useState('');

  const atLimit = isReadOnly && properties.length >= FREE_PROPERTY_LIMIT;

  const handleAddressSelect = (resolved: ResolvedAddress) => {
    setResolvedAddress(resolved);
    setAddress(resolved.address);
    if (resolved.city && resolved.state) {
      setMarket(`${resolved.city}, ${resolved.state}`);
    } else if (resolved.city) {
      setMarket(resolved.city);
    }
  };

  const addProperty = () => {
    if (atLimit) {
      checkout.startCheckout();
      return;
    }
    if (!name.trim()) return;
    const id = generatePropertyId(name.trim());
    const propIsAirbnb = portfolioType === 'str' ? true : portfolioType === 'ltr' ? false : isAirbnb;
    const prop: UserProperty = {
      id,
      label: name.trim(),
      name: name.trim(),
      address: address.trim(),
      units: Math.max(1, parseInt(units) || 1),
      isAirbnb: propIsAirbnb,
      ...(propIsAirbnb && market.trim() ? { market: market.trim() } : {}),
      ...(resolvedAddress?.lat ? { lat: resolvedAddress.lat, lng: resolvedAddress.lng } : {}),
    };
    setProperties(prev => [...prev, prop]);
    setName(''); setAddress(''); setUnits('1'); setIsAirbnb(portfolioType === 'str');
    setMarket(''); setResolvedAddress(null);
  };

  const removeProperty = (index: number) => {
    setProperties(prev => prev.filter((_, i) => i !== index));
  };

  const handleNext = async () => {
    if (name.trim()) addProperty();
    const upyRaw = parseInt(unitsPerYear);
    const upyVal = upyRaw > 0 ? upyRaw : undefined;
    await setProfile({ properties, unitsPerYear: upyVal });
    // Properties sync to backend after registration completes
    navigation.navigate('DataSources');
  };

  const handleSkip = async () => {
    const upyRaw = parseInt(unitsPerYear);
    const upyVal = upyRaw > 0 ? upyRaw : undefined;
    await setProfile({ properties: [], unitsPerYear: upyVal });
    navigation.navigate('DataSources');
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
            <View key={s} style={[styles.dot, s <= 3 && styles.dotActive]} />
          ))}
        </View>

        <Text style={styles.title}>Add your properties</Text>
        <Text style={styles.subtitle}>
          Add all properties you manage. You can always edit these later in Settings.
        </Text>

        {/* Added properties */}
        {properties.length > 0 && (
          <View style={styles.addedSection}>
            {properties.map((p, i) => (
              <View key={i} style={styles.addedCard}>
                {p.lat && p.lng ? (
                  <Image
                    source={{ uri: `${MAPS_PROXY_URL}/api/streetview?lat=${p.lat}&lng=${p.lng}&width=96&height=96` }}
                    style={{ width: 44, height: 44, borderRadius: Radius.sm, marginRight: Spacing.sm }}
                  />
                ) : null}
                <View style={styles.addedInfo}>
                  <View style={styles.addedHeader}>
                    <Text style={styles.addedName}>{p.name}</Text>
                    <View style={[styles.badge, p.isAirbnb ? styles.badgeAirbnb : styles.badgeLTR]}>
                      <Text style={[styles.badgeText, p.isAirbnb ? styles.badgeTextAirbnb : styles.badgeTextLTR]}>
                        {p.isAirbnb ? 'Airbnb' : 'Long-Term'}
                      </Text>
                    </View>
                  </View>
                  {p.address ? <Text style={styles.addedSub}>{p.address}</Text> : null}
                  <Text style={styles.addedSub}>
                    {p.units} {p.units === 1 ? 'unit' : 'units'}
                    {p.market ? ` · ${p.market}` : ''}
                  </Text>
                </View>
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => removeProperty(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={20} color={Colors.textDim} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Form */}
        <View style={styles.formCard}>
          <Text style={styles.label}>Property Name *</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Beach House"
            placeholderTextColor={Colors.textDim}
            autoComplete="off"
            maxLength={100}
          />

          <Text style={styles.label}>Address</Text>
          <AddressAutocomplete
            value={address}
            onChangeText={(t) => { setAddress(t); setResolvedAddress(null); }}
            onSelect={handleAddressSelect}
            placeholder="e.g. 123 Main St, Nashville, TN"
          />

          {/* Street View preview after address resolution */}
          {resolvedAddress && resolvedAddress.lat !== 0 && (
            <View style={{ marginTop: Spacing.sm }}>
              <PropertyStreetView lat={resolvedAddress.lat} lng={resolvedAddress.lng} height={120} />
            </View>
          )}

          <Text style={styles.label}>Units</Text>
          <TextInput
            style={styles.input}
            value={units}
            onChangeText={setUnits}
            placeholder="1"
            placeholderTextColor={Colors.textDim}
            keyboardType="number-pad"
            autoComplete="off"
          />

          {/* Airbnb toggle — only show for "both" */}
          {portfolioType === 'both' && (
            <>
              <Text style={styles.label}>Property Type</Text>
              <View style={styles.toggleRow}>
                <TouchableOpacity activeOpacity={0.7}
          style={[styles.toggleBtn, isAirbnb && styles.toggleBtnActive]}
                  onPress={() => setIsAirbnb(true)}
                >
                  <Text style={[styles.toggleText, isAirbnb && styles.toggleTextActive]}>Airbnb</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
          style={[styles.toggleBtn, !isAirbnb && styles.toggleBtnActive]}
                  onPress={() => setIsAirbnb(false)}
                >
                  <Text style={[styles.toggleText, !isAirbnb && styles.toggleTextActive]}>Non-Airbnb</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Type badge for single portfolio types */}
          {portfolioType === 'str' && (
            <View style={[styles.badge, styles.badgeAirbnb, { alignSelf: 'flex-start', marginTop: Spacing.sm }]}>
              <Text style={[styles.badgeText, styles.badgeTextAirbnb]}>Airbnb Property</Text>
            </View>
          )}
          {portfolioType === 'ltr' && (
            <View style={[styles.badge, styles.badgeLTR, { alignSelf: 'flex-start', marginTop: Spacing.sm }]}>
              <Text style={[styles.badgeText, styles.badgeTextLTR]}>Long-Term</Text>
            </View>
          )}

          {/* Market field — auto-populated from address, editable */}
          {(portfolioType === 'str' || (portfolioType === 'both' && isAirbnb)) && market ? (
            <>
              <Text style={styles.label}>Market</Text>
              <TextInput
                style={styles.input}
                value={market}
                onChangeText={setMarket}
                placeholder="e.g. Nashville, TN"
                placeholderTextColor={Colors.textDim}
                autoComplete="off"
              />
            </>
          ) : null}

          {atLimit ? (
            <TouchableOpacity
              style={[styles.addPropertyBtn, { borderColor: Colors.primary + '40', backgroundColor: Colors.primaryDim }]}
              onPress={checkout.startCheckout}
              disabled={checkout.loading}
              activeOpacity={0.7}
            >
              {checkout.loading ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <>
                  <Ionicons name="diamond-outline" size={16} color={Colors.primary} />
                  <Text style={styles.addPropertyText}>Subscribe to Add More</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.addPropertyBtn, !name.trim() && styles.addPropertyBtnDisabled]}
              onPress={addProperty}
              disabled={!name.trim()}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={18} color={name.trim() ? Colors.primary : Colors.textDim} />
              <Text style={[styles.addPropertyText, !name.trim() && { color: Colors.textDim }]}>
                {properties.length > 0 ? 'Add Another Property' : 'Add Property'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Units per year — for projections */}
        <View style={styles.formCard}>
          <Text style={styles.label}>How many units do you intend on acquiring per year?</Text>
          <Text style={[styles.subtitle, { marginBottom: Spacing.xs }]}>
            This will be used to calculate future year projections.
          </Text>
          <Text style={[styles.subtitle, { marginBottom: Spacing.sm, fontStyle: 'italic' }]}>
            This can be filled out later in Settings if you're unsure.
          </Text>
          <TextInput
            style={styles.input}
            value={unitsPerYear}
            onChangeText={setUnitsPerYear}
            placeholder="e.g. 2"
            placeholderTextColor={Colors.textDim}
            keyboardType="number-pad"
            autoComplete="off"
          />
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleNext} activeOpacity={0.8}>
            <Text style={styles.primaryBtnText}>Next</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.8}>
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
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

  addedSection: { marginBottom: Spacing.lg },
  addedCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.greenDim, borderRadius: Radius.lg,
    padding: Spacing.sm, paddingHorizontal: Spacing.md, marginBottom: Spacing.xs,
  },
  addedInfo: { flex: 1 },
  addedHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  addedName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  addedSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },

  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.pill },
  badgeAirbnb: { backgroundColor: Colors.primaryDim },
  badgeLTR: { backgroundColor: Colors.greenDim },
  badgeText: { fontSize: 10, fontWeight: '600' },
  badgeTextAirbnb: { color: Colors.primary },
  badgeTextLTR: { color: Colors.green },

  formCard: {
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.lg,
  },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  input: {
    backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },

  toggleRow: { flexDirection: 'row', gap: Spacing.sm },
  toggleBtn: { flex: 1, padding: Spacing.sm, borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Colors.glassBorder, alignItems: 'center', backgroundColor: Colors.glassDark, overflow: 'hidden' },
  toggleBtnActive: {
    backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8 },
    }),
  },
  toggleText: { fontSize: FontSize.sm, color: Colors.textDim, fontWeight: '500' },
  toggleTextActive: { color: Colors.text, fontWeight: '600' },

  addPropertyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    padding: Spacing.sm, borderRadius: Radius.lg, marginTop: Spacing.md,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
    backgroundColor: Colors.primaryDim,
  },
  addPropertyBtnDisabled: { borderColor: Colors.border, backgroundColor: 'transparent' },
  addPropertyText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },

  buttons: { gap: Spacing.sm, marginBottom: Spacing.xl },
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
