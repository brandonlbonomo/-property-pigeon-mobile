import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, ScrollView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiSearchUsers } from '../../services/api';
import { MAPS_PROXY_URL } from '../../constants/api';
import { useUserStore } from '../../store/userStore';
import { useOnboardingStore } from '../../store/onboardingStore';

interface SelectedUser {
  user_id: string;
  username: string;
}

interface SearchUser {
  user_id: string;
  username: string;
  role: string;
  plaid_verified_pct?: number | null;
}

export function CleanerFollowOwnerScreen({ navigation }: any) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showHostsQuestion, setShowHostsQuestion] = useState(false);
  const [hostsPerYear, setHostsPerYear] = useState(3);
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);

  // Multi-select users
  const [selectedUsers, setSelectedUsers] = useState<SelectedUser[]>([]);

  // Market discovery — multi-city with glass bubbles
  const [cityInput, setCityInput] = useState('');
  const [cityResults, setCityResults] = useState<string[]>([]);
  const [searchingCities, setSearchingCities] = useState(false);
  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [marketHosts, setMarketHosts] = useState<SearchUser[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(false);

  const setProfile = useUserStore(s => s.setProfile);
  const addPendingFollow = useOnboardingStore(s => s.addPendingFollow);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAlreadySelected = useCallback((userId: string) => {
    return selectedUsers.some(u => u.user_id === userId);
  }, [selectedUsers]);

  // ── City search ──
  const handleCityInputChange = useCallback((text: string) => {
    setCityInput(text);
    if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current);
    if (text.trim().length < 2) {
      setCityResults([]);
      return;
    }
    cityDebounceRef.current = setTimeout(async () => {
      setSearchingCities(true);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(
          `${MAPS_PROXY_URL}/api/places/cities?input=${encodeURIComponent(text.trim())}`,
          { signal: controller.signal },
        );
        clearTimeout(timeout);
        const data = await res.json();
        setCityResults(data.cities || []);
      } catch {
        setCityResults([]);
      } finally {
        setSearchingCities(false);
      }
    }, 300);
  }, []);

  const addCity = useCallback(async (city: string) => {
    setSelectedCities(prev => {
      if (prev.includes(city)) return prev;
      return [...prev, city];
    });
    setCityInput('');
    setCityResults([]);
    // Fetch hosts for this city
    setLoadingMarket(true);
    try {
      const res = await apiSearchUsers('', { market: city });
      setMarketHosts(prev => {
        const existingIds = new Set(prev.map(h => h.user_id));
        const newHosts = (res.users || []).filter((h: SearchUser) => !existingIds.has(h.user_id));
        return [...prev, ...newHosts];
      });
    } catch {}
    setLoadingMarket(false);
  }, []);

  const removeCity = useCallback((city: string) => {
    setSelectedCities(prev => prev.filter(c => c !== city));
    // Remove hosts that were only from this market
    // (simplified: just keep all hosts since they might overlap)
  }, []);

  // ── Username search ──
  const handleInputChange = useCallback((text: string) => {
    setInput(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().toUpperCase().startsWith('PPG-') || text.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiSearchUsers(text.trim());
        setSearchResults(res.users || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
  }, []);

  const addUser = useCallback((user: { user_id: string; username: string }) => {
    setSelectedUsers(prev => {
      if (prev.some(u => u.user_id === user.user_id)) return prev;
      return [...prev, { user_id: user.user_id, username: user.username }];
    });
    setInput('');
    setSearchResults([]);
  }, []);

  const removeUser = useCallback((userId: string) => {
    setSelectedUsers(prev => prev.filter(u => u.user_id !== userId));
  }, []);

  const handleFollow = async () => {
    const hasInput = input.trim().length > 0;
    const hasSelected = selectedUsers.length > 0;
    if (!hasInput && !hasSelected) return;

    // Store follows locally — will send after registration
    for (const user of selectedUsers) {
      addPendingFollow(user.username);
    }
    if (hasInput) {
      addPendingFollow(input.trim());
    }

    if (selectedCities.length > 0) {
      await setProfile({ market: selectedCities[0] });
    }
    setSuccess(true);
    setShowHostsQuestion(true);
  };

  const handleContinue = async () => {
    const profileUpdate: any = { hostsPerYear };
    if (selectedCities.length > 0) profileUpdate.market = selectedCities[0];
    await setProfile(profileUpdate);
    navigation.navigate('CleanerPlaidLanding');
  };

  const handleSkip = async () => {
    if (selectedCities.length > 0) {
      await setProfile({ market: selectedCities[0] });
    }
    setShowHostsQuestion(true);
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
          {[1, 2, 3, 4].map(s => (
            <View key={s} style={[styles.dot, s <= 2 && styles.dotActive]} />
          ))}
        </View>

        {showHostsQuestion ? (
          <>
            {success && (
              <View style={styles.successBox}>
                <Ionicons name="checkmark-circle" size={48} color={Colors.green} />
                <Text style={styles.successTitle}>Request sent!</Text>
                <Text style={styles.successSub}>
                  You're now connected. You can select their properties from your Owners tab.
                </Text>
              </View>
            )}

            <Text style={styles.title}>Growth plans</Text>
            <Text style={styles.subtitle}>
              How many hosts do you intend on adding to your business per year? This helps us project your revenue growth.
            </Text>
            <Text style={[styles.subtitle, { marginBottom: 0, fontStyle: 'italic' }]}>
              This can be filled out later in Settings if you're unsure.
            </Text>

            <View style={styles.stepperRow}>
              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.stepperBtn}
                onPress={() => setHostsPerYear(Math.max(0, hostsPerYear - 1))}
              >
                <Ionicons name="remove" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              <View style={styles.stepperValue}>
                <Text style={styles.stepperNum}>{hostsPerYear}</Text>
                <Text style={styles.stepperLabel}>hosts / year</Text>
              </View>
              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.stepperBtn}
                onPress={() => setHostsPerYear(hostsPerYear + 1)}
              >
                <Ionicons name="add" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity activeOpacity={0.7}
              style={styles.primaryBtn} onPress={handleContinue}>
              <Text style={styles.primaryBtnText}>Continue</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {/* ── Market Discovery ── */}
            <Text style={styles.title}>What market do you service?</Text>
            <Text style={styles.subtitle}>
              Find local Airbnb hosts in your area and connect with them.
            </Text>

            {/* Selected cities — liquid glass bubbles */}
            {selectedCities.length > 0 && (
              <View style={styles.bubblesRow}>
                {selectedCities.map((city) => (
                  <View key={city} style={styles.bubble}>
                    <Ionicons name="location" size={12} color={Colors.primary} />
                    <Text style={styles.bubbleText}>{city}</Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      onPress={() => removeCity(city)}
                    >
                      <Ionicons name="close" size={14} color={Colors.textDim} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* City search input with dropdown */}
            <View style={styles.searchBox}>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.searchInput}
                  value={cityInput}
                  onChangeText={handleCityInputChange}
                  placeholder="e.g. Nashville"
                  placeholderTextColor={Colors.textDim}
                  autoCapitalize="words"
                  autoCorrect={false}
                />
                {searchingCities && (
                  <ActivityIndicator size="small" color={Colors.textDim} style={styles.searchSpinner} />
                )}
              </View>
              {(cityResults.length > 0 || (cityInput.trim().length >= 2 && !searchingCities)) && (
                <View style={styles.resultsList}>
                  {cityResults.map((city, i) => {
                    const alreadyAdded = selectedCities.includes(city);
                    return (
                      <TouchableOpacity
                        key={`${city}-${i}`}
                        activeOpacity={0.7}
                        style={[styles.resultRow, styles.resultRowBorder]}
                        onPress={() => !alreadyAdded && addCity(city)}
                      >
                        <Ionicons name="location-outline" size={16} color={Colors.primary} />
                        <Text style={styles.resultText}>{city}</Text>
                        {alreadyAdded ? (
                          <Ionicons name="checkmark-circle" size={18} color={Colors.green} />
                        ) : (
                          <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
                        )}
                      </TouchableOpacity>
                    );
                  })}
                  {/* Manual entry fallback */}
                  {cityInput.trim().length >= 2 && !cityResults.some(c => c.toLowerCase() === cityInput.trim().toLowerCase()) && (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={styles.resultRow}
                      onPress={() => addCity(cityInput.trim())}
                    >
                      <Ionicons name="create-outline" size={16} color={Colors.textSecondary} />
                      <Text style={styles.manualEntryText}>
                        Don't see your city? Enter "<Text style={{ fontWeight: '700', color: Colors.text }}>{cityInput.trim()}</Text>"
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>

            {/* Market discovery results */}
            {loadingMarket && (
              <ActivityIndicator size="small" color={Colors.primary} style={{ marginTop: Spacing.lg }} />
            )}

            {selectedCities.length > 0 && !loadingMarket && (
              <View style={styles.marketCard}>
                <View style={styles.marketCardHeader}>
                  <Ionicons name="location" size={16} color={Colors.primary} />
                  <Text style={styles.marketCardTitle}>
                    Connect with local hosts!
                  </Text>
                </View>

                {marketHosts.length === 0 ? (
                  <Text style={styles.marketEmpty}>No hosts found in {selectedCities.length === 1 ? selectedCities[0] : 'these markets'} yet.</Text>
                ) : (
                  marketHosts.map((host) => {
                    const selected = isAlreadySelected(host.user_id);
                    return (
                      <TouchableOpacity
                        key={host.user_id}
                        activeOpacity={0.7}
                        style={styles.marketHostRow}
                        onPress={() => !selected && addUser(host)}
                      >
                        <View style={styles.resultAvatar}>
                          <Ionicons name="person" size={14} color={Colors.primary} />
                        </View>
                        <Text style={styles.resultUsername}>@{host.username}</Text>
                        {host.plaid_verified_pct != null && (
                          <View style={styles.plaidBadge}>
                            <Text style={styles.plaidBadgeText}>{Math.round(host.plaid_verified_pct)}% Verified</Text>
                          </View>
                        )}
                        {selected ? (
                          <Ionicons name="checkmark-circle" size={20} color={Colors.green} />
                        ) : (
                          <Ionicons name="add-circle-outline" size={20} color={Colors.primary} />
                        )}
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            )}

            {/* ── Follow section ── */}
            <Text style={[styles.title, { marginTop: Spacing.xl }]}>Follow property owners</Text>
            <Text style={styles.subtitle}>
              Search by username or enter a follow code to connect.
            </Text>

            {/* Selected users — liquid glass bubbles */}
            {selectedUsers.length > 0 && (
              <View style={styles.bubblesRow}>
                {selectedUsers.map((user) => (
                  <View key={user.user_id} style={styles.bubble}>
                    <View style={styles.bubbleAvatar}>
                      <Ionicons name="person" size={10} color={Colors.primary} />
                    </View>
                    <Text style={styles.bubbleText}>@{user.username}</Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      onPress={() => removeUser(user.user_id)}
                    >
                      <Ionicons name="close" size={14} color={Colors.textDim} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {success ? (
              <View style={styles.successBox}>
                <Ionicons name="checkmark-circle" size={48} color={Colors.green} />
                <Text style={styles.successTitle}>Request sent!</Text>
                <Text style={styles.successSub}>
                  You're now connected. You can select their properties from your Owners tab.
                </Text>
                <TouchableOpacity activeOpacity={0.7}
                  style={styles.primaryBtn} onPress={handleContinue}>
                  <Text style={styles.primaryBtnText}>Continue</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.label}>Follow Code or Username</Text>
                <View style={styles.searchBox}>
                  <View style={styles.inputRow}>
                    <TextInput
                      style={styles.searchInput}
                      value={input}
                      onChangeText={handleInputChange}
                      placeholder="PPG-XXXXXX or username"
                      placeholderTextColor={Colors.textDim}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                    />
                    {searching && (
                      <ActivityIndicator size="small" color={Colors.textDim} style={styles.searchSpinner} />
                    )}
                  </View>
                  {searchResults.length > 0 && (
                    <View style={styles.resultsList}>
                      {searchResults.map((user) => {
                        const selected = isAlreadySelected(user.user_id);
                        return (
                          <TouchableOpacity
                            key={user.user_id}
                            activeOpacity={0.7}
                            style={styles.resultRow}
                            onPress={() => addUser(user)}
                          >
                            <View style={styles.resultAvatar}>
                              <Ionicons name="person" size={14} color={Colors.primary} />
                            </View>
                            <Text style={styles.resultUsername}>@{user.username}</Text>
                            {user.plaid_verified_pct != null && (
                              <View style={styles.plaidBadge}>
                                <Text style={styles.plaidBadgeText}>{Math.round(user.plaid_verified_pct)}% Verified</Text>
                              </View>
                            )}
                            {user.role && !selected && (
                              <View style={styles.roleBadge}>
                                <Text style={styles.roleBadgeText}>{user.role}</Text>
                              </View>
                            )}
                            {selected && (
                              <Ionicons name="checkmark-circle" size={18} color={Colors.green} />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>

                <TouchableOpacity activeOpacity={0.7}
                  style={[styles.primaryBtn, (selectedUsers.length === 0 && !input.trim() || loading) && styles.btnDisabled]}
                  onPress={handleFollow}
                  disabled={(selectedUsers.length === 0 && !input.trim()) || loading}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>
                      {selectedUsers.length > 1
                        ? `Send ${selectedUsers.length} Requests`
                        : 'Send Request'}
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity activeOpacity={0.7}
              style={styles.skipBtn}
              onPress={handleSkip}
            >
              <Text style={styles.skipText}>Skip for now</Text>
            </TouchableOpacity>
          </>
        )}
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
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs, marginTop: Spacing.md },

  // Search box (shared between city and username)
  searchBox: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, overflow: 'hidden',
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
  },
  searchInput: {
    flex: 1, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  searchSpinner: { marginRight: 12 },
  resultsList: {
    borderTopWidth: 1, borderTopColor: Colors.glassBorder,
  },
  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
  },
  resultRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.glassBorder,
  },
  resultText: {
    fontSize: FontSize.md, fontWeight: '500', color: Colors.text, flex: 1,
  },
  manualEntryText: {
    fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1, lineHeight: 18,
  },
  resultAvatar: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
    }),
  },
  resultUsername: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, flex: 1 },
  roleBadge: {
    backgroundColor: Colors.primaryDim, borderRadius: Radius.pill,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  roleBadgeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },

  // Plaid badge
  plaidBadge: {
    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  plaidBadgeText: { fontSize: 9, fontWeight: '700', color: Colors.green },

  // Liquid glass bubbles
  bubblesRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  bubble: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 10, paddingVertical: 6,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
      },
    }),
  },
  bubbleAvatar: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  bubbleText: {
    fontSize: FontSize.sm, fontWeight: '600', color: Colors.text,
  },

  // Market discovery card
  marketCard: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    borderRadius: Radius.xl, padding: Spacing.md, overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
    }),
  },
  marketCardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    marginBottom: Spacing.md,
  },
  marketCardTitle: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
  },
  marketEmpty: {
    fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center',
    paddingVertical: Spacing.lg,
  },
  marketHostRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.glassBorder,
  },

  // Buttons
  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.xl,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  skipBtn: { alignItems: 'center', marginTop: Spacing.lg },
  skipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  successBox: { alignItems: 'center', paddingVertical: Spacing.xl },
  successTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  successSub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', marginTop: Spacing.xs, lineHeight: 20,
  },

  // Stepper
  stepperRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.xl, marginTop: Spacing.xl,
  },
  stepperBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
    }),
  },
  stepperValue: { alignItems: 'center' },
  stepperNum: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text },
  stepperLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
});
